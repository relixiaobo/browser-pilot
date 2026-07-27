import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import type { Transport } from '../transport.js';
import type { PageContextOptions } from './page-content-service.js';

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';
export type ScrollUnit = 'pixels' | 'viewport';
export type ScrollPosition = 'start' | 'end';

export interface ScrollEvidence {
  action: 'scroll';
  status: 'verified' | 'mismatch';
  mode: 'relative' | 'position' | 'text';
  target: 'page' | 'element' | 'text';
  moved: boolean;
  deltaX: number;
  deltaY: number;
  beforeX: number;
  beforeY: number;
  afterX: number;
  afterY: number;
  matchedText?: string;
  reason?: 'at_boundary' | 'text_not_found' | 'text_not_revealed';
}

export interface RelativeScrollInput {
  mode: 'relative';
  direction: ScrollDirection;
  amount: number;
  unit: ScrollUnit;
}

export interface PositionScrollInput {
  mode: 'position';
  position: ScrollPosition;
}

export type ElementScrollInput = RelativeScrollInput | PositionScrollInput;

const SCROLL_FUNCTION = `function(spec) {
  const element=this;
  if(!element||!element.isConnected)return{ok:false,error:'Scroll target is detached'};
  const isPage=element===document.scrollingElement||element===document.documentElement||element===document.body;
  const viewportWidth=isPage?Math.max(0,window.innerWidth||document.documentElement.clientWidth||0):Math.max(0,element.clientWidth||0);
  const viewportHeight=isPage?Math.max(0,window.innerHeight||document.documentElement.clientHeight||0):Math.max(0,element.clientHeight||0);
  const beforeX=isPage?Math.max(0,window.scrollX||document.documentElement.scrollLeft||0):Math.max(0,element.scrollLeft||0);
  const beforeY=isPage?Math.max(0,window.scrollY||document.documentElement.scrollTop||0):Math.max(0,element.scrollTop||0);
  if(spec.mode==='position'){
    const x=spec.position==='start'?0:Math.max(0,(element.scrollWidth||document.documentElement.scrollWidth||0)-viewportWidth);
    const y=spec.position==='start'?0:Math.max(0,(element.scrollHeight||document.documentElement.scrollHeight||0)-viewportHeight);
    if(isPage)window.scrollTo({left:x,top:y,behavior:'instant'});
    else element.scrollTo({left:x,top:y,behavior:'instant'});
  }else{
    const basis=spec.direction==='left'||spec.direction==='right'?viewportWidth:viewportHeight;
    const distance=spec.unit==='viewport'?basis*spec.amount:spec.amount;
    const sign=spec.direction==='up'||spec.direction==='left'?-1:1;
    const deltaX=spec.direction==='left'||spec.direction==='right'?distance*sign:0;
    const deltaY=spec.direction==='up'||spec.direction==='down'?distance*sign:0;
    if(isPage)window.scrollBy({left:deltaX,top:deltaY,behavior:'instant'});
    else element.scrollBy({left:deltaX,top:deltaY,behavior:'instant'});
  }
  const afterX=isPage?Math.max(0,window.scrollX||document.documentElement.scrollLeft||0):Math.max(0,element.scrollLeft||0);
  const afterY=isPage?Math.max(0,window.scrollY||document.documentElement.scrollTop||0):Math.max(0,element.scrollTop||0);
  const rounded=value=>Math.round(Number(value)||0);
  const moved=Math.abs(afterX-beforeX)>=1||Math.abs(afterY-beforeY)>=1;
  return{ok:true,action:'scroll',status:moved?'verified':'mismatch',mode:spec.mode,target:isPage?'page':'element',moved,
    deltaX:rounded(afterX-beforeX),deltaY:rounded(afterY-beforeY),beforeX:rounded(beforeX),beforeY:rounded(beforeY),
    afterX:rounded(afterX),afterY:rounded(afterY),...(moved?{}:{reason:'at_boundary'})};
}`;

function parseEvidence(value: unknown): ScrollEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid scroll evidence');
  }
  const record = value as Record<string, unknown>;
  if (record.ok !== true) throw invalidArgument(String(record.error || 'Scroll failed'), 'target');
  const numeric = ['deltaX', 'deltaY', 'beforeX', 'beforeY', 'afterX', 'afterY'];
  if (
    record.action !== 'scroll' || !['verified', 'mismatch'].includes(String(record.status)) ||
    !['relative', 'position', 'text'].includes(String(record.mode)) ||
    !['page', 'element', 'text'].includes(String(record.target)) ||
    typeof record.moved !== 'boolean' || numeric.some(key => !Number.isFinite(record[key]))
  ) {
    throw new BrowserPilotError('internal_error', 'Chrome returned invalid scroll evidence');
  }
  const { ok: _ok, ...evidence } = record;
  return evidence as unknown as ScrollEvidence;
}

function validateInput(input: ElementScrollInput): void {
  if (input.mode === 'relative') {
    if (!['up', 'down', 'left', 'right'].includes(input.direction)) {
      throw invalidArgument('Scroll direction is invalid', 'direction');
    }
    if (!Number.isFinite(input.amount) || input.amount <= 0 || input.amount > 100_000) {
      throw invalidArgument('Scroll amount must be greater than 0 and no more than 100000', 'amount');
    }
    if (!['pixels', 'viewport'].includes(input.unit)) throw invalidArgument('Scroll unit is invalid', 'unit');
    if (input.unit === 'viewport' && input.amount > 100) {
      throw invalidArgument('Viewport scroll amount must be no more than 100', 'amount');
    }
  } else if (!['start', 'end'].includes(input.position)) {
    throw invalidArgument('Scroll position is invalid', 'position');
  }
}

export class ScrollService {
  constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
    private readonly context: PageContextOptions = {},
  ) {}

  async page(input: ElementScrollInput): Promise<ScrollEvidence> {
    validateInput(input);
    const expression = `(${SCROLL_FUNCTION}).call(document.scrollingElement||document.documentElement,${JSON.stringify(input)})`;
    return this.evaluate(expression);
  }

  async selector(selector: string, input: ElementScrollInput): Promise<ScrollEvidence> {
    if (!selector.trim()) throw invalidArgument('Selector must not be empty', 'selector');
    validateInput(input);
    const expression = `(() => {let element;try{element=document.querySelector(${JSON.stringify(selector)})}catch(error){return{ok:false,error:String(error&&error.message||error)}};if(!element)return{ok:false,error:'Scroll target not found'};return(${SCROLL_FUNCTION}).call(element,${JSON.stringify(input)})})()`;
    return this.evaluate(expression, 'selector');
  }

  async object(objectId: string, input: ElementScrollInput): Promise<ScrollEvidence> {
    validateInput(input);
    const { result, exceptionDetails } = await this.transport.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: SCROLL_FUNCTION,
      arguments: [{ value: input }],
      returnByValue: true,
    }, this.sessionId);
    if (exceptionDetails) throw invalidArgument(exceptionDetails.text || 'Scroll failed', 'target');
    return parseEvidence(result?.value);
  }

  async text(text: string, exact = false): Promise<ScrollEvidence> {
    const query = text.trim();
    if (!query) throw invalidArgument('Scroll text must not be empty', 'text');
    const expression = `(() => {
      const query=${JSON.stringify(query)};
      const exact=${exact};
      const normalize=value=>String(value||'').replace(/\\s+/g,' ').trim();
      const needle=normalize(query).toLocaleLowerCase();
      const slash=String.fromCharCode(92);
      const regexSpecials='^$.*+?()[]{}|'+slash;
      const escapeRegex=value=>Array.from(value,char=>regexSpecials.includes(char)?slash+char:char).join('');
      const queryPattern=exact?null:new RegExp(normalize(query).split(' ').map(escapeRegex).join(slash+'s+'),'iu');
      const roots=[document];
      let visited=0;
      while(roots.length&&visited<20000){
        const root=roots.shift();
        const elementWalker=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT);
        let shadowElement;
        while((shadowElement=elementWalker.nextNode())&&visited<20000){
          visited+=1;if(shadowElement.shadowRoot)roots.push(shadowElement.shadowRoot);
        }
        const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
        let node;
        while((node=walker.nextNode())&&visited<20000){
          visited+=1;
          const element=node.parentElement;
          if(!element)continue;
          const tag=String(element.tagName||'').toLowerCase();
          if(['script','style','noscript','template'].includes(tag))continue;
          const raw=String(node.nodeValue||'');
          const content=normalize(raw);
          const normalized=content.toLocaleLowerCase();
          if(!(exact?normalized===needle:normalized.includes(needle)))continue;
          let matchStart=0;
          let matchEnd=raw.length;
          if(exact){
            matchStart=Math.max(0,raw.search(/\\S/u));
            matchEnd=Math.max(matchStart,raw.length-((raw.match(/\\s*$/u)||[''])[0].length));
          }else{
            const match=queryPattern.exec(raw);
            if(!match)continue;
            matchStart=match.index;
            matchEnd=match.index+match[0].length;
          }
          const style=getComputedStyle(element);
          if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||element.getClientRects().length===0)continue;
          const viewportWidth=Math.max(0,window.innerWidth||document.documentElement.clientWidth||0);
          const viewportHeight=Math.max(0,window.innerHeight||document.documentElement.clientHeight||0);
          const range=document.createRange();
          range.setStart(node,matchStart);
          range.setEnd(node,matchEnd);
          const rangeRect=()=>range.getBoundingClientRect();
          const intersectsViewport=rect=>rect.width>0&&rect.height>0&&rect.bottom>0&&rect.right>0&&rect.top<viewportHeight&&rect.left<viewportWidth;
          const beforeX=Math.max(0,window.scrollX||document.documentElement.scrollLeft||0);
          const beforeY=Math.max(0,window.scrollY||document.documentElement.scrollTop||0);
          element.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
          let afterX=Math.max(0,window.scrollX||document.documentElement.scrollLeft||0);
          let afterY=Math.max(0,window.scrollY||document.documentElement.scrollTop||0);
          let rect=rangeRect();
          if(!intersectsViewport(rect)){
            const left=Math.max(0,afterX+rect.left-Math.max(0,(viewportWidth-rect.width)/2));
            const top=Math.max(0,afterY+rect.top-Math.max(0,(viewportHeight-rect.height)/2));
            window.scrollTo({left,top,behavior:'instant'});
            afterX=Math.max(0,window.scrollX||document.documentElement.scrollLeft||0);
            afterY=Math.max(0,window.scrollY||document.documentElement.scrollTop||0);
            rect=rangeRect();
          }
          const round=value=>Math.round(Number(value)||0);
          const moved=Math.abs(afterX-beforeX)>=1||Math.abs(afterY-beforeY)>=1;
          const revealed=intersectsViewport(rect);
          return{ok:true,action:'scroll',status:revealed?'verified':'mismatch',mode:'text',target:'text',moved,
            deltaX:round(afterX-beforeX),deltaY:round(afterY-beforeY),beforeX:round(beforeX),beforeY:round(beforeY),
            afterX:round(afterX),afterY:round(afterY),matchedText:content.slice(0,4096),...(revealed?{}:{reason:'text_not_revealed'})};
        }
      }
      return{ok:true,action:'scroll',status:'mismatch',mode:'text',target:'text',moved:false,
        deltaX:0,deltaY:0,beforeX:round(window.scrollX),beforeY:round(window.scrollY),
        afterX:round(window.scrollX),afterY:round(window.scrollY),reason:'text_not_found'};
      function round(value){return Math.round(Number(value)||0)}
    })()`;
    return this.evaluate(expression, 'text');
  }

  private async evaluate(expression: string, field = 'target'): Promise<ScrollEvidence> {
    const params: Record<string, unknown> = { expression, returnByValue: true };
    if (this.context.executionContextId) params.contextId = this.context.executionContextId;
    const { result, exceptionDetails } = await this.transport.send('Runtime.evaluate', params, this.sessionId);
    if (exceptionDetails) throw invalidArgument(exceptionDetails.text || 'Scroll failed', field);
    return parseEvidence(result?.value);
  }
}
