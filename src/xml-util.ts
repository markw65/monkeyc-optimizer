import { parse } from "../build/xml.js";

export class PeggyError extends Error {
  constructor(
    message: string,
    public location: SourceLocation | null | undefined
  ) {
    super(message);
  }
}

export interface Position {
  /** >= 0 */
  offset: number;
  /** >= 1 */
  line: number;
  /** >= 0 */
  column: number;
}

export interface SourceLocation {
  source?: string | null | undefined;
  start: Position;
  end: Position;
}

interface BaseNode {
  // Every leaf interface that extends BaseNode must specify a type property.
  // The type property should be a string literal.
  type: string;
  loc?: SourceLocation | null | undefined;
  start?: number;
  end?: number;
  range?: [number, number] | undefined;
}

interface AttrStr extends BaseNode {
  type: "attrstr";
  value: string;
}
interface Attribute extends BaseNode {
  type: "attribute";
  name: AttrStr;
  value: AttrStr;
}

interface CharData extends BaseNode {
  type: "chardata";
  value: string;
}
interface CharRef extends BaseNode {
  type: "charref";
  value: number;
  base: 10 | 16;
}
interface Comment extends BaseNode {
  type: "comment";
  value: string;
}
interface DocTypeDecl extends BaseNode {
  type: "doctypedecl";
  name: string;
  externalID?: ExternalID;
  intSubset?: Array<MarkupDecl | PEReference>;
}
interface EntityDecl extends BaseNode {
  type: "entitydecl";
  name: string;
  def: XValue;
  kind: "&" | "%";
}
interface XValue extends BaseNode {
  type: "entityvalue";
  value?: Array<string | Reference | PEReference>;
  extid?: System;
  ndecl?: NData;
}

type Reference = CharRef | EntityRef;
type PEReference = PERef;
type SystemLiteral = string;

interface EntityRef extends BaseNode {
  type: "entityref";
  name: string;
}
interface PERef extends BaseNode {
  type: "peref";
  name: string;
}

interface NotationDecl extends BaseNode {
  type: "notationdecl";
  name: string;
  id: ExternalID | PublicID;
}

interface PublicID extends BaseNode {
  type: "publicid";
  value: string;
}

interface NData extends BaseNode {
  type: "ndata";
  value: string;
}

type ExternalID = System | Public;
type MarkupDecl = EntityDecl | NotationDecl | PI | Comment;

interface System extends BaseNode {
  type: "system";
  value: SystemLiteral;
}

interface Public extends BaseNode {
  type: "public";
  value: SystemLiteral;
  pubid: string;
}

export type Misc = Comment | PI | CharData;

export type Content = Element | Reference | CData | Misc;

export interface CData extends BaseNode {
  type: "cdata";
  value: string;
}

export interface PI extends BaseNode {
  type: "pi";
  name: string;
  value: string | null;
}

export interface Element extends BaseNode {
  type: "element";
  name: string;
  attr: Record<string, Attribute | undefined>;
  children?: Array<Content> | undefined;
}

export interface Prolog extends BaseNode {
  type: "prolog";
  xmldecl?: XmlDecl;
  misc1: Misc[];
  doctypedecl?: DocTypeDecl;
  misc2: Misc[];
}

interface XmlDecl extends BaseNode {
  type: "xmldecl";
  version: "1.0";
  encoding?: string[];
  standalone?: string[];
}

export class Document {
  constructor(
    public prolog: Prolog | null,
    public body: Nodes | Error,
    public misc: Array<Misc>,
    public source?: string
  ) {}
}

export function elementKids(e: Element) {
  return e.children
    ? e.children.filter((c): c is Element => c.type === "element")
    : [];
}

type ElementMatcher = string | ((c: Element) => boolean);

/*
 * Wrapper for an Array<Element>, with various helper methods
 */
export class Nodes {
  public elements: Array<Element>;

  constructor(elements: Element | Element[]) {
    if (Array.isArray(elements)) {
      this.elements = elements;
    } else {
      this.elements = [elements];
    }
  }

  length() {
    return this.elements.length;
  }

  /* For each element, delete element children matching arg */
  deleteChildren(arg: ElementMatcher) {
    const fn = typeof arg === "string" ? (c: Element) => c.name === arg : arg;
    this.elements.forEach(
      (e) =>
        e.children &&
        (e.children = e.children.filter((c) => c.type !== "element" || !fn(c)))
    );
  }

  /* For each element, add elements to its children */
  addChildren(elements: Element[]) {
    this.elements.forEach((e) => {
      if (!e.children) e.children = [];
      e.children.push(...elements);
    });
  }

  /* Return a new Nodes wrapper, with just the elements matching arg */
  filter(arg: ElementMatcher) {
    return new Nodes(
      this.elements.filter(
        typeof arg === "string" ? (c: Element) => c.name === arg : arg
      )
    );
  }

  /*
   * Return a new Nodes wrapper, with any element matching
   * name, replaced it by its children
   */
  skip(name: string) {
    return new Nodes(
      this.elements.flatMap((e) => (e.name === name ? elementKids(e) : e))
    );
  }

  /*
   * Return a new Nodes wrapper, with all elements replaced by
   * their children, optionally restricted to those matching
   * name
   */
  children(name?: string) {
    return new Nodes(
      this.elements
        .flatMap((e) => elementKids(e))
        .filter((c) => !name || c.name === name)
    );
  }

  /*
   * Return an array, with each element replaced by its text
   * content.
   */
  text() {
    return this.elements.map((e) =>
      (e.children || [])
        .map((e) => (e.type === "chardata" ? e.value : ""))
        .join("")
    );
  }

  /*
   * Return an array, with each element replaced by its
   * attributes.
   */
  attrs() {
    return this.elements.map((e) => e.attr);
  }
}

export function attrString(value: string | AttrStr) {
  return typeof value === "string"
    ? ({ type: "attrstr", value } as const)
    : value;
}

export function makeAttribute(
  name: string | AttrStr,
  value: string | AttrStr
): Attribute {
  return {
    type: "attribute",
    name: attrString(name),
    value: attrString(value),
  };
}

export function parseXml(
  content: string,
  fileName: string | null = null
): Document {
  try {
    const [prolog, body, misc] = parse(content, {
      grammarSource: fileName || "unknown",
    });
    return new Document(prolog, new Nodes(body), misc, content);
  } catch (e) {
    return new Document(
      null,
      e instanceof Error ? e : new Error("An unknown error occurred"),
      [],
      content
    );
  }
}

function reference(s: string | Reference | PEReference) {
  if (typeof s === "string") return s;
  switch (s.type) {
    case "charref":
      return s.base === 10
        ? `&#${s.value.toString(10)};`
        : `&#x${s.value.toString(16)};`;

    case "entityref":
      return `&${s.name};`;

    case "peref":
      return `%${s.name};`;
  }
}

function referenceList(refs: Array<string | Reference | PEReference>) {
  return refs.map(reference).join("");
}

function systemString(s: string) {
  return s.includes('"') ? `'${s}'` : `"${s}"`;
}

function attributeString(s: string) {
  // attributes might have double-quotes in them if they were wrapped in
  // single quotes. Also, we explicitly allow <, so we need to fix that here
  // other special characters should already be quoted.
  return `"${s.replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`;
}

function writeNode(
  node:
    | Content
    | ExternalID
    | EntityDecl
    | Prolog
    | XmlDecl
    | DocTypeDecl
    | XValue
    | NData
    | PERef
    | NotationDecl
    | PublicID
    | null
    | undefined
): string {
  if (!node) return "";
  const type = node.type;
  switch (type) {
    case "system":
      return `SYSTEM ${systemString(node.value)}`;
    case "public":
      return `PUBLIC ${systemString(node.pubid)} ${systemString(node.value)}`;
    case "entitydecl":
      return `<!ENTITY${node.kind === "%" ? " %" : ""} ${node.name} ${writeNode(
        node.def
      )}>`;
    case "entityvalue":
      return node.value
        ? attributeString(referenceList(node.value))
        : `${writeNode(node.extid)}${writeNode(node.ndecl)}`;
    case "ndata":
      return ` NDATA ${node.value}`;
    case "xmldecl":
      return `<?xml version=${attributeString(node.version)}${
        node.encoding ? node.encoding.join("") : ""
      }${node.standalone ? node.standalone.join("") : ""} ?>`;
    case "doctypedecl":
      return `<!DOCTYPE ${node.name} ${
        node.externalID ? writeNode(node.externalID) + " " : ""
      }${
        node.intSubset
          ? "[\n  " + node.intSubset.map(writeNode).join("\n  ") + "\n]"
          : ""
      }>`;
    case "peref":
      return reference(node);
    case "notationdecl":
      return `<!NOTATION ${node.name} ${writeNode(node.id)}>`;
    case "publicid":
      return `PUBLIC ${node.value}`;
    case "prolog":
      return `${writeNode(node.xmldecl)}${node.misc1
        .map(writeNode)
        .join("")}${writeNode(node.doctypedecl)}${node.misc2
        .map(writeNode)
        .join("")}`;
    case "element": {
      const start = `<${node.name}${Object.entries(node.attr)
        .map(([k, v]) => ` ${k}=${attributeString(v!.value.value)}`)
        .join("")}`;
      return node.children && node.children.length
        ? `${start}>${node.children.map(writeNode).join("")}</${node.name}>`
        : `${start}/>`;
    }
    case "charref":
    case "entityref":
      return reference(node);
    case "chardata":
      return node.value;
    case "comment":
      return `<!--${node.value}-->`;
    case "cdata":
      return `<![CDATA[${node.value}]]>`;
    case "pi":
      return `<?${node.name}?>`;
    default:
      ((s: never) => {
        throw new Error(`${s} Not handled in switch`);
      })(type);
  }
}

export function writeXml(doc: Document) {
  if (doc.body instanceof Error) {
    throw doc.body;
  }
  const parts: string[] = [];
  parts.push(writeNode(doc.prolog));
  doc.body.elements.forEach((e) => parts.push(writeNode(e)));
  doc.misc.forEach((e) => parts.push(writeNode(e)));
  return parts.join("");
}
