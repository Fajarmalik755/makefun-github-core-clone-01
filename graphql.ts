// GraphQL v4 surface for the github-core-clone-01 forge.
//
// Hand-rolled minimal GraphQL parser + executor (stdlib only, no GraphQL
// library) covering exactly the documents gh / github-mcp-server send —
// see kit program/env/src/checks-graphql.ts and graphql-client.ts.
// Route: POST /api/graphql only. Auth via isAuthed(ctx); unauthenticated
// is HTTP 401. A GraphQL-level failure (unknown field, bad argument) is
// HTTP 200 with a non-empty `errors` array, never a 4xx.

import { VIEWER, NOW_ISO, isAuthed, type Store, type Repo, type Issue, type PullRequest } from './store.ts';

export interface Ctx {
  token: string | undefined;
}
export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
}
export interface Resp {
  status: number;
  headers?: Record<string, string>;
  body: Buffer | string | object;
}

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };

// ---------------------------------------------------------------------------------------------------------
// Global ids + cursors (opaque, stable across reads).
// ---------------------------------------------------------------------------------------------------------

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function unb64url(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function repoGlobalId(repoId: number): string {
  return `R_${b64url(`repo:${repoId}`)}`;
}
function issueGlobalId(repoId: number, number: number): string {
  return `I_${b64url(`issue:${repoId}:${number}`)}`;
}
function prGlobalId(repoId: number, number: number): string {
  return `PR_${b64url(`pr:${repoId}:${number}`)}`;
}
function commentGlobalId(repoId: number, commentId: number): string {
  return `C_${b64url(`comment:${repoId}:${commentId}`)}`;
}

type DecodedId =
  | { kind: 'repo'; repoId: number }
  | { kind: 'issue'; repoId: number; number: number }
  | { kind: 'pr'; repoId: number; number: number }
  | { kind: 'comment'; repoId: number; commentId: number };

function decodeGlobalId(id: string): DecodedId | null {
  const m = /^(R|I|PR|C)_(.+)$/.exec(id);
  if (m === null) return null;
  const text = unb64url(m[2]);
  if (text === null) return null;
  const parts = text.split(':');
  const num = (s: string | undefined): number | null => {
    if (s === undefined || s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  if (m[1] === 'R' && parts[0] === 'repo' && parts.length === 2) {
    const repoId = num(parts[1]);
    return repoId === null ? null : { kind: 'repo', repoId };
  }
  if (m[1] === 'I' && parts[0] === 'issue' && parts.length === 3) {
    const repoId = num(parts[1]);
    const number = num(parts[2]);
    return repoId === null || number === null ? null : { kind: 'issue', repoId, number };
  }
  if (m[1] === 'PR' && parts[0] === 'pr' && parts.length === 3) {
    const repoId = num(parts[1]);
    const number = num(parts[2]);
    return repoId === null || number === null ? null : { kind: 'pr', repoId, number };
  }
  if (m[1] === 'C' && parts[0] === 'comment' && parts.length === 3) {
    const repoId = num(parts[1]);
    const commentId = num(parts[2]);
    return repoId === null || commentId === null ? null : { kind: 'comment', repoId, commentId };
  }
  return null;
}

function encodeCursor(number: number): string {
  return b64url(`cursor:${number}`);
}

/** Decode an `after` cursor. null input => null (no filter). Throws on garbage. */
function decodeCursor(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new GqlExecError('Invalid cursor');
  const text = unb64url(value);
  const m = text === null ? null : /^cursor:(\d+)$/.exec(text);
  if (m === null) throw new GqlExecError('Invalid cursor');
  return Number(m[1]);
}

// ---------------------------------------------------------------------------------------------------------
// Lexer.
// ---------------------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct';
interface Token {
  kind: TokenKind;
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      // Block string """...""" or plain "...".
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end === -1) throw new GqlExecError('Unterminated string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else if (esc !== undefined) out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new GqlExecError('Unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlExecError(`Unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------------------
// Parser: operations, variable definitions, fields, arguments, inline fragments.
// ---------------------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

type SelectionNode =
  | { kind: 'field'; name: string; alias: string | null; args: Record<string, ValueNode>; selections: SelectionNode[] }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface VarDef {
  name: string;
  defaultValue?: ValueNode;
}
interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: VarDef[];
  selections: SelectionNode[];
}
interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}
interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (t === undefined) throw new GqlExecError('Unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }
  private isPunct(value: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'punct' && t.value === value;
  }
  private eatPunct(value: string): boolean {
    if (this.isPunct(value)) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectPunct(value: string): void {
    if (!this.eatPunct(value)) throw new GqlExecError(`Expected "${value}" in GraphQL document`);
  }
  private isName(value?: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'name' && (value === undefined || t.value === value);
  }
  private expectName(what = 'a name'): string {
    const t = this.next();
    if (t.kind !== 'name') throw new GqlExecError(`Expected ${what} in GraphQL document`);
    return t.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.pos < this.tokens.length) {
      if (this.isName('fragment')) {
        this.next();
        const name = this.expectName('a fragment name');
        if (!this.isName('on')) throw new GqlExecError('Expected "on" in fragment definition');
        this.next();
        const typeCondition = this.expectName('a type name');
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
      } else {
        operations.push(this.parseOperation());
      }
    }
    if (operations.length === 0) throw new GqlExecError('No operation in GraphQL document');
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let kind: Operation['kind'] = 'query';
    let name: string | null = null;
    if (this.isName('query') || this.isName('mutation') || this.isName('subscription')) {
      kind = this.next().value as Operation['kind'];
      if (this.peek()?.kind === 'name') name = this.next().value;
    }
    const varDefs = this.isPunct('(') ? this.parseVarDefs() : [];
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind, name, varDefs, selections };
  }

  private parseVarDefs(): VarDef[] {
    this.expectPunct('(');
    const defs: VarDef[] = [];
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const varName = this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.eatPunct('=')) defaultValue = this.parseValue();
      defs.push({ name: varName, defaultValue });
      if (this.pos >= this.tokens.length) throw new GqlExecError('Unterminated variable definitions');
    }
    this.expectPunct(')');
    return defs;
  }

  /** Consume a type reference ([T!]!, T!, T) — only its shape matters here. */
  private parseType(): void {
    if (this.eatPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    this.eatPunct('!');
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName('a directive name');
      if (this.isPunct('(')) this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      selections.push(this.parseSelection());
      if (this.pos >= this.tokens.length) throw new GqlExecError('Unterminated selection set');
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      if (this.isName('on')) {
        this.next();
        const typeCondition = this.expectName('a type name');
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek()?.kind === 'name') {
        return { kind: 'fragmentSpread', name: this.next().value };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first;
    if (this.eatPunct(':')) {
      alias = first;
      name = this.expectName('a field name');
    }
    const args = this.isPunct('(') ? this.parseArguments() : {};
    this.skipDirectives();
    const selections = this.isPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    this.expectPunct('(');
    const args: Record<string, ValueNode> = {};
    while (!this.isPunct(')')) {
      const argName = this.expectName('an argument name');
      this.expectPunct(':');
      args[argName] = this.parseValue();
      if (this.pos >= this.tokens.length) throw new GqlExecError('Unterminated arguments');
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) {
        values.push(this.parseValue());
        if (this.pos >= this.tokens.length) throw new GqlExecError('Unterminated list value');
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct('}')) {
        const fieldName = this.expectName('an input field name');
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
        if (this.pos >= this.tokens.length) throw new GqlExecError('Unterminated input object');
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new GqlExecError(`Unexpected token ${JSON.stringify(t.value)} in GraphQL value`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

class GqlExecError extends Error {}

// ---------------------------------------------------------------------------------------------------------
// Schema: field names per type (also the introspection lists) and return types for validation.
// ---------------------------------------------------------------------------------------------------------

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: { login: 'String', id: 'ID', name: 'String', email: 'String' },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: 'String',
    hasIssuesEnabled: 'Boolean',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
    description: 'String',
    private: 'Boolean',
    createdAt: 'String',
    updatedAt: 'String',
  },
  Ref: { name: 'String' },
  Issue: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    state: 'String',
    body: 'String',
    createdAt: 'String',
    updatedAt: 'String',
    author: 'User',
    comments: 'IssueCommentConnection',
    labels: '[Label]',
  },
  IssueConnection: { nodes: '[Issue]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequest: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    state: 'String',
    merged: 'Boolean',
    mergedAt: 'String',
    headRefName: 'String',
    baseRefName: 'String',
    mergeable: 'String',
    files: 'PullRequestChangedFileConnection',
    body: 'String',
    createdAt: 'String',
    updatedAt: 'String',
    author: 'User',
  },
  PullRequestConnection: { nodes: '[PullRequest]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFile: { path: 'String', status: 'String', additions: 'Int', deletions: 'Int', changes: 'Int' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', endCursor: 'String', startCursor: 'String' },
  __Type: { name: 'String', kind: 'String', description: 'String', fields: '[__Field]', enumValues: '[__EnumValue]' },
  __Field: { name: 'String', description: 'String' },
  __EnumValue: { name: 'String', description: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', comment: 'IssueComment', clientMutationId: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  IssueComment: { id: 'ID', body: 'String', createdAt: 'String', updatedAt: 'String', author: 'User' },
  IssueCommentConnection: { nodes: '[IssueComment]', pageInfo: 'PageInfo', totalCount: 'Int' },
  Label: { name: 'String', color: 'String' },
};

const ISSUE_FIELD_NAMES = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments', 'labels'];
const PULL_REQUEST_FIELD_NAMES = [
  'id', 'number', 'title', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'createdAt', 'updatedAt', 'author',
];
const REPOSITORY_FIELD_NAMES = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
  'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt',
];
const SEARCH_TYPE_ENUM_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION', 'COMMIT'];

function unwrapList(type: string): string {
  return type.startsWith('[') && type.endsWith(']') ? type.slice(1, -1) : type;
}

// ---------------------------------------------------------------------------------------------------------
// Validation: unknown fields are GraphQL errors (HTTP 200), never 4xx.
// ---------------------------------------------------------------------------------------------------------

function validateSelections(
  selections: SelectionNode[],
  parentType: string,
  fragments: Map<string, FragmentDef>,
  errors: { message: string }[],
): void {
  for (const sel of selections) {
    if (sel.kind === 'field') {
      if (sel.name === '__typename') continue;
      const fields = FIELD_TYPES[parentType];
      if (parentType === 'Node') {
        if (sel.name !== 'id') {
          errors.push({ message: `Cannot query field "${sel.name}" on type "Node".` });
        }
        continue;
      }
      if (fields === undefined || !(sel.name in fields)) {
        errors.push({ message: `Cannot query field "${sel.name}" on type "${parentType}".` });
        continue;
      }
      if (sel.selections.length > 0) {
        const child = unwrapList(fields[sel.name]);
        if (SCALARS.has(child)) {
          errors.push({ message: `Field "${sel.name}" must not have a selection since type "${child}" has no subfields.` });
        } else {
          validateSelections(sel.selections, child, fragments, errors);
        }
      }
    } else if (sel.kind === 'inlineFragment') {
      validateSelections(sel.selections, sel.typeCondition ?? parentType, fragments, errors);
    } else {
      const frag = fragments.get(sel.name);
      if (frag === undefined) {
        errors.push({ message: `Unknown fragment "${sel.name}".` });
      } else {
        validateSelections(frag.selections, frag.typeCondition, fragments, errors);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------------------------------------

interface ObjRef {
  __obj: true;
  typeName: string;
  value: unknown;
  repo?: Repo;
  repoId?: number;
}

function objRef(typeName: string, value: unknown, repo?: Repo, repoId?: number): ObjRef {
  return { __obj: true, typeName, value, repo, repoId };
}
function isObjRef(v: unknown): v is ObjRef {
  return v !== null && typeof v === 'object' && (v as ObjRef).__obj === true;
}

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
}

function findRepoById(store: Store, repoId: number): Repo | undefined {
  return store.listRepos().find((r) => r.id === repoId);
}

function pageInfoRef(hasNextPage: boolean, endCursor: string | null, startCursor: string | null): ObjRef {
  return objRef('PageInfo', { hasNextPage, hasPreviousPage: false, endCursor, startCursor });
}

function connectionRef(
  typeName: string,
  nodes: ObjRef[],
  hasNextPage: boolean,
  endCursor: string | null,
  startCursor: string | null,
  totalCount: number,
): ObjRef {
  return objRef(typeName, { nodes, pageInfo: pageInfoRef(hasNextPage, endCursor, startCursor), totalCount });
}

function issueRef(repo: Repo, issue: Issue): ObjRef {
  return objRef('Issue', issue, repo, repo.id);
}
function prRef(repo: Repo, pr: PullRequest): ObjRef {
  return objRef('PullRequest', pr, repo, repo.id);
}

function issuesConnection(store: Store, repo: Repo, args: Record<string, unknown>): ObjRef {
  let list = [...repo.issues];
  const states = args['states'];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args['orderBy'];
  let direction = 'ASC';
  if (orderBy !== null && typeof orderBy === 'object') {
    const dir = (orderBy as Record<string, unknown>)['direction'];
    if (typeof dir === 'string') direction = dir;
  }
  list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const afterNum = decodeCursor(args['after']);
  if (afterNum !== null) list = list.filter((i) => i.number > afterNum);
  const total = list.length;
  const first = typeof args['first'] === 'number' ? args['first'] : undefined;
  const page = first !== undefined ? list.slice(0, first) : list;
  const hasNext = first !== undefined ? list.length > first : false;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  const startCursor = page.length > 0 ? encodeCursor(page[0].number) : null;
  return connectionRef('IssueConnection', page.map((i) => issueRef(repo, i)), hasNext, endCursor, startCursor, total);
}

function pullsConnection(store: Store, repo: Repo, args: Record<string, unknown>): ObjRef {
  const list = [...repo.pulls].sort((a, b) => a.number - b.number);
  const total = list.length;
  const first = typeof args['first'] === 'number' ? args['first'] : undefined;
  const page = first !== undefined ? list.slice(0, first) : list;
  const hasNext = first !== undefined ? list.length > first : false;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  const startCursor = page.length > 0 ? encodeCursor(page[0].number) : null;
  return connectionRef('PullRequestConnection', page.map((p) => prRef(repo, p)), hasNext, endCursor, startCursor, total);
}

function resolveField(parentType: string, parent: ObjRef, fieldName: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const store = ctx.store;
  const v = parent.value as Record<string, unknown>;

  if (fieldName === '__typename') return parent.typeName;

  switch (parentType) {
    case 'Query': {
      if (fieldName === 'viewer') return objRef('User', VIEWER);
      if (fieldName === 'repository') {
        const repo = store.getRepo(String(args['owner'] ?? ''), String(args['name'] ?? ''));
        return repo === undefined ? null : objRef('Repository', repo);
      }
      if (fieldName === 'node') {
        const decoded = typeof args['id'] === 'string' ? decodeGlobalId(args['id']) : null;
        if (decoded === null) return null;
        if (decoded.kind === 'repo') {
          const repo = findRepoById(store, decoded.repoId);
          return repo === undefined ? null : objRef('Repository', repo);
        }
        const repo = findRepoById(store, decoded.repoId);
        if (repo === undefined) return null;
        if (decoded.kind === 'issue') {
          const issue = repo.issues.find((i) => i.number === decoded.number);
          return issue === undefined ? null : issueRef(repo, issue);
        }
        if (decoded.kind === 'pr') {
          const pr = repo.pulls.find((p) => p.number === decoded.number);
          return pr === undefined ? null : prRef(repo, pr);
        }
        // comment node
        for (const issue of repo.issues) {
          const comment = issue.comments.find((c) => c.id === decoded.commentId);
          if (comment !== undefined) return objRef('IssueComment', comment, repo, repo.id);
        }
        return null;
      }
      if (fieldName === '__type') {
        const name = String(args['name'] ?? '');
        if (name === 'Issue') return objRef('__Type', { name, kind: 'OBJECT', fields: ISSUE_FIELD_NAMES, enumValues: null });
        if (name === 'PullRequest') return objRef('__Type', { name, kind: 'OBJECT', fields: PULL_REQUEST_FIELD_NAMES, enumValues: null });
        if (name === 'Repository') return objRef('__Type', { name, kind: 'OBJECT', fields: REPOSITORY_FIELD_NAMES, enumValues: null });
        if (name === 'SearchType') return objRef('__Type', { name, kind: 'ENUM', fields: null, enumValues: SEARCH_TYPE_ENUM_VALUES });
        if (name in FIELD_TYPES) {
          return objRef('__Type', { name, kind: 'OBJECT', fields: Object.keys(FIELD_TYPES[name]), enumValues: null });
        }
        return null;
      }
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "Query".`);
    }
    case 'Mutation': {
      if (fieldName === 'createIssue') return mutateCreateIssue(ctx, args);
      if (fieldName === 'closeIssue') return mutateCloseIssue(ctx, args);
      if (fieldName === 'createPullRequest') return mutateCreatePullRequest(ctx, args);
      if (fieldName === 'mergePullRequest') return mutateMergePullRequest(ctx, args);
      if (fieldName === 'addComment') return mutateAddComment(ctx, args);
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "Mutation".`);
    }
    case 'User': {
      const user = v as unknown as { id: number; login: string; name: string; email: string };
      if (fieldName === 'login') return user.login;
      if (fieldName === 'id') return user.id;
      if (fieldName === 'name') return user.name ?? '';
      if (fieldName === 'email') return user.email ?? '';
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "User".`);
    }
    case 'Repository': {
      const repo = parent.value as Repo;
      if (fieldName === 'id') return repoGlobalId(repo.id);
      if (fieldName === 'databaseId') return repo.id;
      if (fieldName === 'name') return repo.name;
      if (fieldName === 'nameWithOwner') return repo.fullName();
      if (fieldName === 'owner') return objRef('User', VIEWER.login === repo.owner ? VIEWER : { id: 1002, login: repo.owner, name: repo.owner, email: '' });
      if (fieldName === 'defaultBranchRef') {
        return repo.headSha() === undefined ? null : objRef('Ref', { name: repo.defaultBranch });
      }
      if (fieldName === 'viewerPermission') return 'ADMIN';
      if (fieldName === 'hasIssuesEnabled') return true;
      if (fieldName === 'description') return repo.description;
      if (fieldName === 'private') return repo.private;
      if (fieldName === 'createdAt') return repo.createdAt;
      if (fieldName === 'updatedAt') return repo.updatedAt;
      if (fieldName === 'issue') {
        const issue = repo.issues.find((i) => i.number === args['number']);
        return issue === undefined ? null : issueRef(repo, issue);
      }
      if (fieldName === 'issues') return issuesConnection(store, repo, args);
      if (fieldName === 'pullRequests') return pullsConnection(store, repo, args);
      if (fieldName === 'pullRequest') {
        const pr = repo.pulls.find((p) => p.number === args['number']);
        return pr === undefined ? null : prRef(repo, pr);
      }
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "Repository".`);
    }
    case 'Ref': {
      if (fieldName === 'name') return String(v['name'] ?? '');
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "Ref".`);
    }
    case 'Issue': {
      const issue = parent.value as Issue;
      const repo = parent.repo as Repo;
      if (fieldName === 'id') return issueGlobalId(repo.id, issue.number);
      if (fieldName === 'number') return issue.number;
      if (fieldName === 'title') return issue.title;
      if (fieldName === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (fieldName === 'body') return issue.body ?? '';
      if (fieldName === 'createdAt') return issue.createdAt;
      if (fieldName === 'updatedAt') return issue.updatedAt;
      if (fieldName === 'author') {
        return objRef('User', issue.userLogin === VIEWER.login ? VIEWER : { id: 1002, login: issue.userLogin, name: issue.userLogin, email: '' });
      }
      if (fieldName === 'comments') {
        const nodes = issue.comments.map((c) => objRef('IssueComment', c, repo, repo.id));
        return connectionRef('IssueCommentConnection', nodes, false, null, null, nodes.length);
      }
      if (fieldName === 'labels') {
        return issue.labels.map((name) => objRef('Label', { name, color: '' }));
      }
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "Issue".`);
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'IssueCommentConnection': {
      if (fieldName === 'nodes') return (v['nodes'] as ObjRef[]) ?? [];
      if (fieldName === 'pageInfo') return v['pageInfo'] as ObjRef;
      if (fieldName === 'totalCount') return (v['totalCount'] as number) ?? 0;
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "${parentType}".`);
    }
    case 'PullRequest': {
      const pr = parent.value as PullRequest;
      const repo = parent.repo as Repo;
      if (fieldName === 'id') return prGlobalId(repo.id, pr.number);
      if (fieldName === 'number') return pr.number;
      if (fieldName === 'title') return pr.title;
      if (fieldName === 'state') return pr.state === 'open' ? 'OPEN' : 'CLOSED';
      if (fieldName === 'merged') return pr.merged;
      if (fieldName === 'mergedAt') return pr.mergedAt;
      if (fieldName === 'headRefName') return pr.headRef;
      if (fieldName === 'baseRefName') return pr.baseRef;
      if (fieldName === 'mergeable') return store.isMergeable(repo, pr) ? 'MERGEABLE' : 'CONFLICTING';
      if (fieldName === 'body') return pr.body ?? '';
      if (fieldName === 'createdAt') return pr.createdAt;
      if (fieldName === 'updatedAt') return pr.updatedAt;
      if (fieldName === 'author') {
        return objRef('User', pr.userLogin === VIEWER.login ? VIEWER : { id: 1002, login: pr.userLogin, name: pr.userLogin, email: '' });
      }
      if (fieldName === 'files') {
        const changed = store.changedFiles(repo, pr.baseRef, pr.headRef);
        const first = typeof args['first'] === 'number' ? args['first'] : undefined;
        const page = first !== undefined ? changed.slice(0, first) : changed;
        const nodes = page.map((f) =>
          objRef('PullRequestChangedFile', { path: f.filename, status: f.status.toUpperCase(), additions: f.additions, deletions: f.deletions, changes: f.changes }),
        );
        return connectionRef('PullRequestChangedFileConnection', nodes, false, null, null, changed.length);
      }
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "PullRequest".`);
    }
    case 'PullRequestChangedFile': {
      if (fieldName === 'path') return String(v['path'] ?? '');
      if (fieldName === 'status') return String(v['status'] ?? '');
      if (fieldName === 'additions') return (v['additions'] as number) ?? 0;
      if (fieldName === 'deletions') return (v['deletions'] as number) ?? 0;
      if (fieldName === 'changes') return (v['changes'] as number) ?? 0;
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "PullRequestChangedFile".`);
    }
    case 'PageInfo': {
      if (fieldName === 'hasNextPage') return Boolean(v['hasNextPage']);
      if (fieldName === 'hasPreviousPage') return Boolean(v['hasPreviousPage']);
      if (fieldName === 'endCursor') return (v['endCursor'] as string | null) ?? null;
      if (fieldName === 'startCursor') return (v['startCursor'] as string | null) ?? null;
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "PageInfo".`);
    }
    case '__Type': {
      if (fieldName === 'name') return String(v['name'] ?? '');
      if (fieldName === 'kind') return String(v['kind'] ?? '');
      if (fieldName === 'description') return null;
      if (fieldName === 'fields') {
        const fields = v['fields'] as string[] | null;
        return fields === null ? null : fields.map((name) => objRef('__Field', { name }));
      }
      if (fieldName === 'enumValues') {
        const values = v['enumValues'] as string[] | null;
        return values === null ? null : values.map((name) => objRef('__EnumValue', { name }));
      }
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "__Type".`);
    }
    case '__Field':
    case '__EnumValue': {
      if (fieldName === 'name') return String(v['name'] ?? '');
      if (fieldName === 'description') return null;
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "${parentType}".`);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (fieldName === 'issue') return (v['issue'] as ObjRef | null) ?? null;
      if (fieldName === 'clientMutationId') return null;
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "${parentType}".`);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (fieldName === 'pullRequest') return (v['pullRequest'] as ObjRef | null) ?? null;
      if (fieldName === 'clientMutationId') return null;
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "${parentType}".`);
    }
    case 'AddCommentPayload': {
      if (fieldName === 'commentEdge') return (v['commentEdge'] as ObjRef | null) ?? null;
      if (fieldName === 'comment') return (v['comment'] as ObjRef | null) ?? null;
      if (fieldName === 'clientMutationId') return null;
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "${parentType}".`);
    }
    case 'IssueCommentEdge': {
      if (fieldName === 'node') return (v['node'] as ObjRef | null) ?? null;
      if (fieldName === 'cursor') return String(v['cursor'] ?? '');
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "IssueCommentEdge".`);
    }
    case 'IssueComment': {
      const comment = parent.value as { id: number; body: string; userLogin: string; createdAt: string; updatedAt: string };
      const repo = parent.repo as Repo;
      if (fieldName === 'id') return commentGlobalId(repo.id, comment.id);
      if (fieldName === 'body') return comment.body;
      if (fieldName === 'createdAt') return comment.createdAt;
      if (fieldName === 'updatedAt') return comment.updatedAt;
      if (fieldName === 'author') {
        return objRef('User', comment.userLogin === VIEWER.login ? VIEWER : { id: 1002, login: comment.userLogin, name: comment.userLogin, email: '' });
      }
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "IssueComment".`);
    }
    case 'Label': {
      if (fieldName === 'name') return String(v['name'] ?? '');
      if (fieldName === 'color') return String(v['color'] ?? '');
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "Label".`);
    }
    default:
      throw new GqlExecError(`Cannot query field "${fieldName}" on type "${parentType}".`);
  }
}

function asInput(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function mutateCreateIssue(ctx: ExecCtx, args: Record<string, unknown>): ObjRef {
  const input = asInput(args['input']);
  const decoded = typeof input['repositoryId'] === 'string' ? decodeGlobalId(input['repositoryId']) : null;
  if (decoded === null || decoded.kind !== 'repo') throw new GqlExecError('Repository not found');
  const repo = findRepoById(ctx.store, decoded.repoId);
  if (repo === undefined) throw new GqlExecError('Repository not found');
  const title = typeof input['title'] === 'string' ? input['title'] : '';
  const body = typeof input['body'] === 'string' ? input['body'] : '';
  const result = ctx.store.createIssue(repo, title, body, []);
  if ('error' in result) throw new GqlExecError(`Unknown label: ${String((result as { label?: unknown }).label ?? '')}`);
  return objRef('CreateIssuePayload', { issue: issueRef(repo, result) });
}

function mutateCloseIssue(ctx: ExecCtx, args: Record<string, unknown>): ObjRef {
  const input = asInput(args['input']);
  const decoded = typeof input['issueId'] === 'string' ? decodeGlobalId(input['issueId']) : null;
  if (decoded === null || decoded.kind !== 'issue') throw new GqlExecError('Issue not found');
  const repo = findRepoById(ctx.store, decoded.repoId);
  const issue = repo?.issues.find((i) => i.number === decoded.number);
  if (repo === undefined || issue === undefined) throw new GqlExecError('Issue not found');
  issue.state = 'closed';
  issue.updatedAt = NOW_ISO;
  return objRef('CloseIssuePayload', { issue: issueRef(repo, issue) });
}

function mutateCreatePullRequest(ctx: ExecCtx, args: Record<string, unknown>): ObjRef {
  const input = asInput(args['input']);
  const decoded = typeof input['repositoryId'] === 'string' ? decodeGlobalId(input['repositoryId']) : null;
  if (decoded === null || decoded.kind !== 'repo') throw new GqlExecError('Repository not found');
  const repo = findRepoById(ctx.store, decoded.repoId);
  if (repo === undefined) throw new GqlExecError('Repository not found');
  const title = typeof input['title'] === 'string' ? input['title'] : '';
  const body = typeof input['body'] === 'string' ? input['body'] : '';
  const head = typeof input['headRefName'] === 'string' ? input['headRefName'] : '';
  const base = typeof input['baseRefName'] === 'string' ? input['baseRefName'] : '';
  const result = ctx.store.createPull(repo, title, body, head, base);
  if ('error' in result) throw new GqlExecError(String((result as { error: unknown }).error));
  return objRef('CreatePullRequestPayload', { pullRequest: prRef(repo, result) });
}

function mutateMergePullRequest(ctx: ExecCtx, args: Record<string, unknown>): ObjRef {
  const input = asInput(args['input']);
  const decoded = typeof input['pullRequestId'] === 'string' ? decodeGlobalId(input['pullRequestId']) : null;
  if (decoded === null || decoded.kind !== 'pr') throw new GqlExecError('Pull request not found');
  const repo = findRepoById(ctx.store, decoded.repoId);
  const pr = repo?.pulls.find((p) => p.number === decoded.number);
  if (repo === undefined || pr === undefined) throw new GqlExecError('Pull request not found');
  const methodRaw = typeof input['mergeMethod'] === 'string' ? input['mergeMethod'].toLowerCase() : 'squash';
  const method: 'squash' | 'merge' | 'rebase' = methodRaw === 'merge' ? 'merge' : methodRaw === 'rebase' ? 'rebase' : 'squash';
  const result = ctx.store.mergePull(repo, pr.number, method);
  if ('error' in result) throw new GqlExecError(String((result as { error: unknown }).error));
  return objRef('MergePullRequestPayload', { pullRequest: prRef(repo, pr) });
}

function mutateAddComment(ctx: ExecCtx, args: Record<string, unknown>): ObjRef {
  const input = asInput(args['input']);
  const decoded = typeof input['subjectId'] === 'string' ? decodeGlobalId(input['subjectId']) : null;
  if (decoded === null || decoded.kind !== 'issue') throw new GqlExecError('Issue not found');
  const repo = findRepoById(ctx.store, decoded.repoId);
  const issue = repo?.issues.find((i) => i.number === decoded.number);
  if (repo === undefined || issue === undefined) throw new GqlExecError('Issue not found');
  const body = typeof input['body'] === 'string' ? input['body'] : '';
  const comment = {
    id: repo.nextCommentId++,
    body,
    userLogin: VIEWER.login,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
  issue.comments.push(comment);
  const node = objRef('IssueComment', comment, repo, repo.id);
  const edge = objRef('IssueCommentEdge', { node, cursor: commentGlobalId(repo.id, comment.id) });
  return objRef('AddCommentPayload', { commentEdge: edge, comment: node });
}

function executeSelections(parent: ObjRef, declaredType: string, selections: SelectionNode[], ctx: ExecCtx): Record<string, unknown> {
  const concreteType = parent.typeName;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'field') {
      const key = sel.alias ?? sel.name;
      const args: Record<string, unknown> = {};
      for (const [name, node] of Object.entries(sel.args)) args[name] = resolveValue(node, ctx.variables);
      const value = resolveField(concreteType, parent, sel.name, args, ctx);
      out[key] = projectValue(value, sel, ctx);
    } else if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition === null || sel.typeCondition === concreteType || sel.typeCondition === declaredType) {
        Object.assign(out, executeSelections(parent, sel.typeCondition ?? declaredType, sel.selections, ctx));
      }
    } else {
      const frag = ctx.fragments.get(sel.name);
      if (frag !== undefined) {
        if (frag.typeCondition === concreteType || frag.typeCondition === declaredType) {
          Object.assign(out, executeSelections(parent, frag.typeCondition, frag.selections, ctx));
        }
      }
    }
  }
  return out;
}

function projectValue(value: unknown, sel: Extract<SelectionNode, { kind: 'field' }>, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => projectValue(v, sel, ctx));
  if (isObjRef(value)) {
    if (sel.selections.length === 0) return {};
    const childType = unwrapList(FIELD_TYPES[value.typeName]?.[sel.name] ?? '');
    void childType;
    return executeSelections(value, value.typeName, sel.selections, ctx);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------
// One operation.
// ---------------------------------------------------------------------------------------------------------

interface GqlResult {
  data: Record<string, unknown> | null;
  errors?: { message: string }[];
}

function executeOperation(store: Store, doc: Document, op: Operation, variables: Record<string, unknown>): GqlResult {
  const vars: Record<string, unknown> = { ...variables };
  for (const def of op.varDefs) {
    if (vars[def.name] === undefined && def.defaultValue !== undefined) {
      vars[def.name] = resolveValue(def.defaultValue, vars);
    }
  }
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const errors: { message: string }[] = [];
  validateSelections(op.selections, rootType, doc.fragments, errors);
  if (errors.length > 0) return { data: null, errors };
  const ctx: ExecCtx = { store, variables: vars, fragments: doc.fragments };
  try {
    const root = objRef(rootType, null);
    const data = executeSelections(root, rootType, op.selections, ctx);
    return { data };
  } catch (err) {
    if (err instanceof GqlExecError) return { data: null, errors: [{ message: err.message }] };
    throw err;
  }
}

function executeOne(store: Store, body: unknown): GqlResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'GraphQL request body must be an object with a query string' }] };
  }
  const record = body as Record<string, unknown>;
  const query = record['query'];
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  let doc: Document;
  try {
    doc = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const variables = record['variables'];
  const vars: Record<string, unknown> =
    variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
  let op: Operation | undefined;
  const operationName = record['operationName'];
  if (typeof operationName === 'string' && operationName !== '') {
    op = doc.operations.find((o) => o.name === operationName);
    if (op === undefined) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else {
    if (doc.operations.length !== 1) {
      return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
    }
    op = doc.operations[0];
  }
  try {
    return executeOperation(store, doc, op, vars);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

// ---------------------------------------------------------------------------------------------------------
// HTTP handler.
// ---------------------------------------------------------------------------------------------------------

export async function handleGraphql(store: Store, ctx: Ctx, req: Req): Promise<Resp | null> {
  if (req.method !== 'POST') return null;
  if (req.path !== '/api/graphql' && req.path !== '/api/graphql/') return null;
  if (!isAuthed(ctx)) {
    return { status: 401, headers: JSON_HEADERS, body: { message: 'Unauthorized' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    return { status: 400, headers: JSON_HEADERS, body: { errors: [{ message: 'Malformed JSON body' }] } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => executeOne(store, entry));
    return { status: 200, headers: JSON_HEADERS, body: results };
  }
  return { status: 200, headers: JSON_HEADERS, body: executeOne(store, parsed) };
}
