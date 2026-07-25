import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import type { Transport } from '../transport.js';
import type { PageContextOptions } from './page-content-service.js';

export type DropdownKind = 'native' | 'aria';

export interface DropdownOption {
  index: number;
  label: string;
  value: string;
  selected: boolean;
  disabled: boolean;
}

export interface DropdownInfo {
  kind: DropdownKind;
  expanded: boolean;
  multiple: boolean;
  requiresOpen: boolean;
  options: DropdownOption[];
  truncated: boolean;
}

export type DropdownChoice =
  | { by: 'index'; index: number }
  | { by: 'label'; label: string; exact: boolean }
  | { by: 'value'; value: string; exact: boolean };

export interface SelectVerificationEvidence {
  action: 'select';
  status: 'verified' | 'mismatch' | 'unavailable';
  kind: DropdownKind;
  selected: DropdownOption[];
  reason?: 'option_not_found' | 'selection_mismatch' | 'selection_not_exposed';
}

const READ_DROPDOWN = `function() {
  const target=this;
  if(!target||target.nodeType!==1||!target.isConnected)return{ok:false,error:'Dropdown target is detached'};
  const normalize=value=>String(value||'').replace(/\\s+/g,' ').trim();
  const tag=String(target.tagName||'').toLowerCase();
  const role=String(target.getAttribute?.('role')||'').trim().toLowerCase();
  const isNative=tag==='select';
  if(!isNative&&!['combobox','listbox'].includes(role))return{ok:false,error:'Target is not a native or ARIA dropdown'};
  let optionElements=[];
  if(isNative){
    optionElements=Array.from(target.options||[]);
  }else{
    const ids=String(target.getAttribute?.('aria-controls')||target.getAttribute?.('aria-owns')||'').trim().split(/\\s+/).filter(Boolean);
    const roots=[];
    const localRoot=target.getRootNode?.();
    for(const id of ids){
      const controlled=localRoot?.getElementById?.(id)||document.getElementById(id);
      if(controlled)roots.push(controlled);
    }
    if(role==='listbox')roots.push(target);
    if(roots.length===0)roots.push(target);
    optionElements=roots.flatMap(root=>[
      ...(root.matches?.('[role="option"],[role="menuitemradio"]')?[root]:[]),
      ...Array.from(root.querySelectorAll?.('[role="option"],[role="menuitemradio"]')||[]),
    ]);
  }
  const seen=new Set();
  const options=[];
  let total=0;
  for(const option of optionElements){
    if(seen.has(option))continue;seen.add(option);total+=1;
    if(options.length>=500)continue;
    const optionTag=String(option.tagName||'').toLowerCase();
    const selected=optionTag==='option'?!!option.selected:String(option.getAttribute?.('aria-selected')||option.getAttribute?.('aria-checked')||'').toLowerCase()==='true';
    const disabled=!!option.disabled||option.matches?.(':disabled')||String(option.getAttribute?.('aria-disabled')||'').toLowerCase()==='true';
    options.push({index:total,label:normalize(option.label||option.getAttribute?.('aria-label')||option.textContent).slice(0,4096),
      value:String(option.value??option.getAttribute?.('data-value')??option.getAttribute?.('aria-label')??normalize(option.textContent)).slice(0,4096),
      selected,disabled:!!disabled});
  }
  const expanded=isNative||String(target.getAttribute?.('aria-expanded')||'').toLowerCase()==='true'||role==='listbox';
  return{ok:true,kind:isNative?'native':'aria',expanded,multiple:isNative?!!target.multiple:String(target.getAttribute?.('aria-multiselectable')||'').toLowerCase()==='true',
    requiresOpen:!isNative&&!expanded&&total===0,options,truncated:total>options.length};
}`;

const SELECT_NATIVE = `function(choice) {
  const target=this;
  if(!target||target.nodeType!==1||!target.isConnected)return{ok:false,error:'Dropdown target is detached'};
  if(String(target.tagName||'').toLowerCase()!=='select')return{ok:false,error:'Target is not a native select'};
  const normalize=value=>String(value||'').replace(/\\s+/g,' ').trim();
  const options=Array.from(target.options||[]);
  const compare=(actual,expected,exact)=>{
    const left=normalize(actual).toLocaleLowerCase();
    const right=normalize(expected).toLocaleLowerCase();
    return exact?left===right:left.includes(right);
  };
  let match;
  if(choice.by==='index')match=options[choice.index-1];
  else if(choice.by==='label')match=options.find(option=>compare(option.label||option.textContent,choice.label,choice.exact));
  else match=options.find(option=>compare(option.value,choice.value,choice.exact));
  if(!match||match.disabled)return{ok:true,action:'select',status:'mismatch',kind:'native',selected:[],reason:'option_not_found'};
  const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')?.set;
  if(target.multiple){
    for(const option of options)option.selected=option===match;
  }else if(setter){setter.call(target,match.value)}else{target.value=match.value}
  target.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
  target.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
  const selected=options.map((option,index)=>({option,index})).filter(item=>item.option.selected).map(item=>({
    index:item.index+1,label:normalize(item.option.label||item.option.textContent).slice(0,4096),value:String(item.option.value||'').slice(0,4096),selected:true,disabled:!!item.option.disabled,
  })).slice(0,500);
  const verified=selected.some(option=>option.index===options.indexOf(match)+1);
  return{ok:true,action:'select',status:verified?'verified':'mismatch',kind:'native',selected,
    ...(verified?{}:{reason:'selection_mismatch'})};
}`;

const READ_OWNED_ARIA_OPTION = `function(option) {
  const target=this;
  if(!target||target.nodeType!==1||!target.isConnected||!option||option.nodeType!==1||!option.isConnected)return null;
  const role=String(target.getAttribute?.('role')||'').trim().toLowerCase();
  if(!['combobox','listbox'].includes(role))return null;
  const ids=String(target.getAttribute?.('aria-controls')||target.getAttribute?.('aria-owns')||'').trim().split(/\\s+/).filter(Boolean);
  const roots=[];
  const localRoot=target.getRootNode?.();
  for(const id of ids){
    const controlled=localRoot?.getElementById?.(id)||document.getElementById(id);
    if(controlled)roots.push(controlled);
  }
  if(role==='listbox')roots.push(target);
  if(roots.length===0)roots.push(target);
  const optionElements=[];
  const seen=new Set();
  for(const root of roots){
    const candidates=[
      ...(root.matches?.('[role="option"],[role="menuitemradio"]')?[root]:[]),
      ...Array.from(root.querySelectorAll?.('[role="option"],[role="menuitemradio"]')||[]),
    ];
    for(const candidate of candidates){
      if(seen.has(candidate))continue;
      seen.add(candidate);optionElements.push(candidate);
    }
  }
  const index=optionElements.indexOf(option);
  if(index<0)return null;
  const normalize=value=>String(value||'').replace(/\\s+/g,' ').trim();
  const selected=String(option.getAttribute?.('aria-selected')||option.getAttribute?.('aria-checked')||'').toLowerCase()==='true';
  const disabled=option.matches?.(':disabled')||String(option.getAttribute?.('aria-disabled')||'').toLowerCase()==='true';
  return{index:index+1,label:normalize(option.getAttribute?.('aria-label')||option.textContent).slice(0,4096),
    value:String(option.value??option.getAttribute?.('data-value')??option.getAttribute?.('aria-label')??normalize(option.textContent)).slice(0,4096),
    selected,disabled:!!disabled};
}`;

function parseObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrowserPilotError('internal_error', `Chrome returned invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function parseDropdown(value: unknown): DropdownInfo {
  const record = parseObject(value, 'dropdown information');
  if (record.ok !== true) throw invalidArgument(String(record.error || 'Dropdown inspection failed'), 'target');
  if (
    !['native', 'aria'].includes(String(record.kind)) ||
    typeof record.expanded !== 'boolean' || typeof record.multiple !== 'boolean' ||
    typeof record.requiresOpen !== 'boolean' || !Array.isArray(record.options) ||
    typeof record.truncated !== 'boolean'
  ) throw new BrowserPilotError('internal_error', 'Chrome returned invalid dropdown information');
  const { ok: _ok, ...info } = record;
  return info as unknown as DropdownInfo;
}

function parseEvidence(value: unknown): SelectVerificationEvidence {
  const record = parseObject(value, 'dropdown selection evidence');
  if (record.ok !== true) throw invalidArgument(String(record.error || 'Dropdown selection failed'), 'target');
  if (
    record.action !== 'select' || !['verified', 'mismatch', 'unavailable'].includes(String(record.status)) ||
    !['native', 'aria'].includes(String(record.kind)) || !Array.isArray(record.selected)
  ) throw new BrowserPilotError('internal_error', 'Chrome returned invalid dropdown selection evidence');
  const { ok: _ok, ...evidence } = record;
  return evidence as unknown as SelectVerificationEvidence;
}

function selectorExpression(selector: string, functionDeclaration: string, argument?: unknown): string {
  return `(() => {let target;try{target=document.querySelector(${JSON.stringify(selector)})}catch(error){return{ok:false,error:String(error&&error.message||error)}};if(!target)return{ok:false,error:'Dropdown target not found'};return(${functionDeclaration}).call(target${argument === undefined ? '' : `,${JSON.stringify(argument)}`})})()`;
}

export class DropdownService {
  constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
    private readonly context: PageContextOptions = {},
  ) {}

  async inspectObject(objectId: string): Promise<DropdownInfo> {
    const { result, exceptionDetails } = await this.transport.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: READ_DROPDOWN,
      returnByValue: true,
    }, this.sessionId);
    if (exceptionDetails) throw invalidArgument(exceptionDetails.text || 'Dropdown inspection failed', 'target');
    return parseDropdown(result?.value);
  }

  inspectSelector(selector: string): Promise<DropdownInfo> {
    if (!selector.trim()) throw invalidArgument('Selector must not be empty', 'selector');
    return this.evaluate(selectorExpression(selector, READ_DROPDOWN), 'selector').then(parseDropdown);
  }

  async selectNativeObject(objectId: string, choice: DropdownChoice): Promise<SelectVerificationEvidence> {
    const { result, exceptionDetails } = await this.transport.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: SELECT_NATIVE,
      arguments: [{ value: choice }],
      returnByValue: true,
    }, this.sessionId);
    if (exceptionDetails) throw invalidArgument(exceptionDetails.text || 'Dropdown selection failed', 'target');
    return parseEvidence(result?.value);
  }

  async inspectOwnedAriaOption(
    targetObjectId: string,
    optionObjectId: string,
  ): Promise<DropdownOption | undefined> {
    const { result, exceptionDetails } = await this.transport.send('Runtime.callFunctionOn', {
      objectId: targetObjectId,
      functionDeclaration: READ_OWNED_ARIA_OPTION,
      arguments: [{ objectId: optionObjectId }],
      returnByValue: true,
    }, this.sessionId);
    if (exceptionDetails) throw invalidArgument(exceptionDetails.text || 'Dropdown option inspection failed', 'target');
    if (result?.value === null || result?.value === undefined) return undefined;
    const option = parseObject(result.value, 'dropdown option');
    if (
      !Number.isSafeInteger(option.index) || Number(option.index) < 1 ||
      typeof option.label !== 'string' || typeof option.value !== 'string' ||
      typeof option.selected !== 'boolean' || typeof option.disabled !== 'boolean'
    ) throw new BrowserPilotError('internal_error', 'Chrome returned invalid dropdown option');
    return option as unknown as DropdownOption;
  }

  selectNativeSelector(selector: string, choice: DropdownChoice): Promise<SelectVerificationEvidence> {
    if (!selector.trim()) throw invalidArgument('Selector must not be empty', 'selector');
    return this.evaluate(selectorExpression(selector, SELECT_NATIVE, choice), 'selector').then(parseEvidence);
  }

  static unavailableAriaSelection(): SelectVerificationEvidence {
    return {
      action: 'select',
      status: 'unavailable',
      kind: 'aria',
      selected: [],
      reason: 'selection_not_exposed',
    };
  }

  private async evaluate(expression: string, field: string): Promise<unknown> {
    const params: Record<string, unknown> = { expression, returnByValue: true };
    if (this.context.executionContextId) params.contextId = this.context.executionContextId;
    const { result, exceptionDetails } = await this.transport.send('Runtime.evaluate', params, this.sessionId);
    if (exceptionDetails) throw invalidArgument(exceptionDetails.text || 'Dropdown operation failed', field);
    return result?.value;
  }
}
