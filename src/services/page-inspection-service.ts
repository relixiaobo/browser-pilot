import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import type { Transport } from '../transport.js';
import type { PageContextOptions } from './page-content-service.js';

const MAX_SEARCH_MATCHES = 200;
const MAX_FIND_ELEMENTS = 200;
const MAX_ATTRIBUTE_NAMES = 20;

export interface PageSearchMatch {
  index: number;
  text: string;
  context: string;
  tagName: string;
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageSearchResult {
  title: string;
  url: string;
  totalMatches: number;
  matches: PageSearchMatch[];
  truncated: boolean;
}

export interface FoundElementAttribute {
  name: string;
  value: string;
}

export interface FoundElement {
  index: number;
  tagName: string;
  role: string;
  name: string;
  text: string;
  visible: boolean;
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  attributes: FoundElementAttribute[];
}

export interface FindElementsResult {
  title: string;
  url: string;
  totalMatches: number;
  elements: FoundElement[];
  truncated: boolean;
}

function parseJsonResult(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'string') {
    throw new BrowserPilotError('internal_error', `Chrome returned invalid ${label}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new BrowserPilotError('internal_error', `Chrome returned invalid ${label}`, { cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BrowserPilotError('internal_error', `Chrome returned invalid ${label}`);
  }
  return parsed as Record<string, unknown>;
}

function evaluationError(exceptionDetails: any, fallback: string, field?: string): BrowserPilotError {
  return invalidArgument(
    exceptionDetails?.exception?.description || exceptionDetails?.text || fallback,
    field,
  );
}

function searchScript(input: {
  query: string;
  selector?: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  limit: number;
}): string {
  return `JSON.stringify((() => {
    const query=${JSON.stringify(input.query)};
    const selector=${input.selector === undefined ? 'null' : JSON.stringify(input.selector)};
    const caseSensitive=${input.caseSensitive};
    const wholeWord=${input.wholeWord};
    const limit=${input.limit};
    let root;
    try { root=selector?document.querySelector(selector):(document.body||document.documentElement); }
    catch(error) { return {ok:false,field:'selector',error:String(error&&error.message||error)}; }
    if(!root)return{ok:false,field:'selector',error:'Search root not found'};
    const normalize=value=>String(value||'').replace(/\\s+/g,' ').trim();
    const normalizedQuery=normalize(query);
    if(!normalizedQuery)return{ok:false,field:'query',error:'Search query must not be empty'};
    const needle=caseSensitive?normalizedQuery:normalizedQuery.toLocaleLowerCase();
    const word=value=>/^[\\p{L}\\p{N}_]$/u.test(value||'');
    const visible=element=>{
      if(!element||element.nodeType!==1)return false;
      const view=element.ownerDocument?.defaultView||window;
      for(let current=element;current;current=current.parentElement){
        const style=view.getComputedStyle(current);
        if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;
        if(current.hidden||current.getAttribute?.('aria-hidden')==='true'||current.inert)return false;
      }
      return element.getClientRects().length>0;
    };
    const roots=[root];
    const matches=[];
    let totalMatches=0;
    let visitedNodes=0;
    let visitedCharacters=0;
    let scanTruncated=false;
    while(roots.length&&visitedNodes<20000&&visitedCharacters<2000000){
      const currentRoot=roots.shift();
      const walker=document.createTreeWalker(currentRoot,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);
      let node;
      while((node=walker.nextNode())){
        visitedNodes+=1;
        if(visitedNodes>=20000){scanTruncated=true;break;}
        if(node.nodeType===1){
          if(node.shadowRoot)roots.push(node.shadowRoot);
          continue;
        }
        const parent=node.parentElement;
        const tag=String(parent?.tagName||'').toLowerCase();
        if(!parent||['script','style','noscript','template','svg'].includes(tag)||!visible(parent))continue;
        const text=normalize(node.nodeValue);
        if(!text)continue;
        visitedCharacters+=text.length;
        if(visitedCharacters>=2000000)scanTruncated=true;
        const haystack=caseSensitive?text:text.toLocaleLowerCase();
        let from=0;
        while(from<=haystack.length-needle.length){
          const offset=haystack.indexOf(needle,from);
          if(offset<0)break;
          from=offset+Math.max(1,needle.length);
          if(wholeWord&&(word(text[offset-1])||word(text[offset+needle.length])))continue;
          totalMatches+=1;
          if(matches.length>=limit)continue;
          const rect=parent.getBoundingClientRect();
          const contextStart=Math.max(0,offset-120);
          const contextEnd=Math.min(text.length,offset+normalizedQuery.length+120);
          matches.push({
            index:totalMatches,
            text:text.slice(offset,offset+normalizedQuery.length).slice(0,4096),
            context:text.slice(contextStart,contextEnd).slice(0,500),
            tagName:tag.slice(0,64),visible:true,
            x:Math.round(rect.x),y:Math.round(rect.y),
            width:Math.max(0,Math.round(rect.width)),height:Math.max(0,Math.round(rect.height)),
          });
        }
      }
    }
    return{ok:true,title:String(document.title||'').slice(0,4096),url:String(location.href).slice(0,16384),
      totalMatches,matches,truncated:scanTruncated||totalMatches>matches.length};
  })())`;
}

function findElementsScript(input: {
  selector: string;
  limit: number;
  attributeNames: string[];
  pierceShadow: boolean;
}): string {
  return `JSON.stringify((() => {
    const selector=${JSON.stringify(input.selector)};
    const limit=${input.limit};
    const requestedAttributes=${JSON.stringify(input.attributeNames)};
    const pierceShadow=${input.pierceShadow};
    // Each root carries the page offset of the frame it lives in. A child
    // document reports rects relative to its own viewport, so without this the
    // coordinates would be wrong in exactly the way a click cannot survive.
    const roots=[{node:document,dx:0,dy:0}];
    const matches=[];
    const seen=new Set();
    let totalMatches=0;
    let scannedRoots=0;
    const normalize=(value,max)=>String(value||'').replace(/\\s+/g,' ').trim().slice(0,max);
    const implicitRole=element=>{
      const tag=String(element.tagName||'').toLowerCase();
      if(tag==='a'&&element.hasAttribute('href'))return'link';
      if(tag==='button')return'button';
      if(tag==='select')return element.multiple?'listbox':'combobox';
      if(tag==='textarea')return'textbox';
      if(tag==='input'){
        const type=String(element.type||'text').toLowerCase();
        if(type==='checkbox'||type==='radio'||type==='button'||type==='submit'||type==='reset')return type==='submit'||type==='reset'?'button':type;
        return type==='search'?'searchbox':'textbox';
      }
      if(tag==='option')return'option';
      return'';
    };
    const accessibleName=element=>{
      const aria=element.getAttribute?.('aria-label');
      if(aria)return normalize(aria,4096);
      const labelledBy=String(element.getAttribute?.('aria-labelledby')||'').trim().split(/\\s+/).filter(Boolean);
      if(labelledBy.length){
        const label=labelledBy.map(id=>document.getElementById(id)?.textContent||'').join(' ');
        if(normalize(label,4096))return normalize(label,4096);
      }
      if(element.labels?.length){
        const label=Array.from(element.labels).map(item=>item.textContent||'').join(' ');
        if(normalize(label,4096))return normalize(label,4096);
      }
      return normalize(element.getAttribute?.('alt')||element.getAttribute?.('title')||element.textContent,4096);
    };
    const state=element=>{
      let visible=true;
      let enabled=true;
      const view=element.ownerDocument?.defaultView||window;
      for(let current=element;current;current=current.parentElement){
        const style=view.getComputedStyle(current);
        if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0||current.hidden||current.inert){visible=false;break;}
        if(current.matches?.(':disabled')||current.getAttribute?.('aria-disabled')==='true'||current.inert)enabled=false;
      }
      if(element.getClientRects().length===0)visible=false;
      return{visible,enabled};
    };
    while(roots.length&&scannedRoots<512){
      const entry=roots.shift();
      const root=entry.node;
      const dx=entry.dx;
      const dy=entry.dy;
      scannedRoots+=1;
      let selected;
      try{selected=root.querySelectorAll(selector);}catch(error){return{ok:false,field:'selector',error:String(error&&error.message||error)};}
      for(const element of selected){
        if(seen.has(element))continue;
        seen.add(element);totalMatches+=1;
        if(matches.length>=limit)continue;
        const rect=element.getBoundingClientRect();
        const currentState=state(element);
        const attributes=[];
        for(const name of requestedAttributes){
          if(!element.hasAttribute?.(name))continue;
          attributes.push({name,value:String(element.getAttribute(name)||'').slice(0,2048)});
        }
        matches.push({
          index:totalMatches,tagName:String(element.tagName||'').toLowerCase().slice(0,64),
          role:normalize(element.getAttribute?.('role')||implicitRole(element),128),
          name:accessibleName(element),text:normalize(element.innerText||element.textContent,500),
          visible:currentState.visible,enabled:currentState.enabled,
          x:Math.round(rect.x+dx),y:Math.round(rect.y+dy),width:Math.max(0,Math.round(rect.width)),height:Math.max(0,Math.round(rect.height)),
          attributes,
        });
      }
      // Walk for nested roots even when shadow piercing is off: a snapshot
      // reports controls inside same-origin frames, so a selector for one of
      // them must resolve rather than return nothing.
      const ownerDocument=root.ownerDocument||root;
      const walker=ownerDocument.createTreeWalker(root,NodeFilter.SHOW_ELEMENT);
      let element;
      while((element=walker.nextNode())){
        if(pierceShadow&&element.shadowRoot)roots.push({node:element.shadowRoot,dx,dy});
        if(String(element.tagName||'').toLowerCase()!=='iframe')continue;
        // Cross-origin frames throw or yield null here, which is the boundary
        // a snapshot draws too -- they are simply not reachable from this
        // document, and nothing else in this script can see them.
        let childDocument=null;
        try{childDocument=element.contentDocument;}catch(error){childDocument=null;}
        if(!childDocument)continue;
        const frameRect=element.getBoundingClientRect();
        roots.push({node:childDocument,dx:dx+frameRect.x,dy:dy+frameRect.y});
      }
    }
    return{ok:true,title:String(document.title||'').slice(0,4096),url:String(location.href).slice(0,16384),
      totalMatches,elements:matches,truncated:roots.length>0||totalMatches>matches.length};
  })())`;
}

export class PageInspectionService {
  constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
  ) {}

  async search(
    query: string,
    options: {
      selector?: string;
      caseSensitive?: boolean;
      wholeWord?: boolean;
      limit?: number;
      context?: PageContextOptions;
    } = {},
  ): Promise<PageSearchResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw invalidArgument('Search query must not be empty', 'query');
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_MATCHES) {
      throw invalidArgument(`Search limit must be an integer from 1 through ${MAX_SEARCH_MATCHES}`, 'limit');
    }
    const params: Record<string, unknown> = {
      expression: searchScript({
        query: normalizedQuery,
        selector: options.selector,
        caseSensitive: options.caseSensitive ?? false,
        wholeWord: options.wholeWord ?? false,
        limit,
      }),
      returnByValue: true,
    };
    if (options.context?.executionContextId) params.contextId = options.context.executionContextId;
    const { result, exceptionDetails } = await this.transport.send('Runtime.evaluate', params, this.sessionId);
    if (exceptionDetails) throw evaluationError(exceptionDetails, 'Page search failed');
    const data = parseJsonResult(result?.value, 'page search result');
    if (data.ok !== true) {
      throw invalidArgument(String(data.error || 'Page search failed'), data.field === 'selector' ? 'selector' : 'query');
    }
    return data as unknown as PageSearchResult;
  }

  async find(
    selector: string,
    options: {
      limit?: number;
      attributeNames?: string[];
      pierceShadow?: boolean;
      context?: PageContextOptions;
    } = {},
  ): Promise<FindElementsResult> {
    if (!selector.trim()) throw invalidArgument('Selector must not be empty', 'selector');
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FIND_ELEMENTS) {
      throw invalidArgument(`Element limit must be an integer from 1 through ${MAX_FIND_ELEMENTS}`, 'limit');
    }
    const attributeNames = options.attributeNames ?? ['id', 'class', 'name', 'type', 'href', 'placeholder', 'data-testid'];
    if (
      attributeNames.length > MAX_ATTRIBUTE_NAMES ||
      attributeNames.some(name => !/^[A-Za-z_:][A-Za-z0-9_.:-]{0,127}$/.test(name))
    ) {
      throw invalidArgument(`Attribute names must be valid and contain at most ${MAX_ATTRIBUTE_NAMES} entries`, 'attributeNames');
    }
    const params: Record<string, unknown> = {
      expression: findElementsScript({
        selector,
        limit,
        attributeNames: [...new Set(attributeNames)],
        pierceShadow: options.pierceShadow ?? true,
      }),
      returnByValue: true,
    };
    if (options.context?.executionContextId) params.contextId = options.context.executionContextId;
    const { result, exceptionDetails } = await this.transport.send('Runtime.evaluate', params, this.sessionId);
    if (exceptionDetails) throw evaluationError(exceptionDetails, 'Element query failed', 'selector');
    const data = parseJsonResult(result?.value, 'element query result');
    if (data.ok !== true) throw invalidArgument(String(data.error || 'Element query failed'), 'selector');
    return data as unknown as FindElementsResult;
  }
}
