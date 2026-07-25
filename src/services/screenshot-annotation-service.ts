import { BrowserPilotError, invalidArgument } from '../protocol/errors.js';
import type { Transport } from '../transport.js';
import type { BrowserMedia } from './capture-service.js';

export interface ScreenshotAnnotation {
  ref: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotViewport {
  width: number;
  height: number;
}

const MAX_ANNOTATIONS = 200;

function annotationScript(
  data: string,
  annotations: readonly ScreenshotAnnotation[],
  viewport: ScreenshotViewport,
): string {
  return `(async() => {
    const source=${JSON.stringify(`data:image/png;base64,${data}`)};
    const annotations=${JSON.stringify(annotations)};
    const viewport=${JSON.stringify(viewport)};
    const response=await fetch(source);
    const bitmap=await createImageBitmap(await response.blob());
    const canvas=document.createElement('canvas');
    canvas.width=bitmap.width;canvas.height=bitmap.height;
    const context=canvas.getContext('2d');
    if(!context)throw new Error('Canvas 2D context is unavailable');
    context.drawImage(bitmap,0,0);
    const scaleX=bitmap.width/viewport.width;
    const scaleY=bitmap.height/viewport.height;
    const fontSize=Math.max(12,Math.round(14*Math.min(scaleX,scaleY)));
    context.font='bold '+fontSize+'px sans-serif';
    context.textBaseline='top';
    for(const annotation of annotations){
      const x=Math.round(annotation.x*scaleX);
      const y=Math.round(annotation.y*scaleY);
      const width=Math.max(1,Math.round(annotation.width*scaleX));
      const height=Math.max(1,Math.round(annotation.height*scaleY));
      context.fillStyle='rgba(255, 214, 10, 0.16)';
      context.fillRect(x,y,width,height);
      context.strokeStyle='#e11d48';
      context.lineWidth=Math.max(2,Math.round(2*Math.min(scaleX,scaleY)));
      context.strokeRect(x,y,width,height);
      const label=String(annotation.ref);
      const metrics=context.measureText(label);
      const labelWidth=Math.ceil(metrics.width)+10;
      const labelHeight=fontSize+6;
      const labelX=Math.max(0,Math.min(bitmap.width-labelWidth,x));
      const labelY=Math.max(0,y-labelHeight);
      context.fillStyle='#e11d48';
      context.fillRect(labelX,labelY,labelWidth,labelHeight);
      context.fillStyle='#ffffff';
      context.fillText(label,labelX+5,labelY+3);
    }
    bitmap.close?.();
    return canvas.toDataURL('image/png');
  })()`;
}

export class ScreenshotAnnotationService {
  constructor(
    private readonly transport: Transport,
    private readonly sessionId: string,
  ) {}

  async annotate(
    media: BrowserMedia,
    annotations: readonly ScreenshotAnnotation[],
    viewport: ScreenshotViewport,
  ): Promise<BrowserMedia> {
    if (media.mimeType !== 'image/png') throw invalidArgument('Only PNG screenshots can be annotated');
    if (
      !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) ||
      viewport.width <= 0 || viewport.height <= 0
    ) throw new BrowserPilotError('internal_error', 'Screenshot viewport is invalid');
    if (annotations.length > MAX_ANNOTATIONS) {
      throw invalidArgument(`Screenshot annotations are limited to ${MAX_ANNOTATIONS}`, 'refs');
    }
    if (annotations.some(annotation => (
      !Number.isSafeInteger(annotation.ref) || annotation.ref < 1 ||
      ![annotation.x, annotation.y, annotation.width, annotation.height].every(Number.isFinite) ||
      annotation.width <= 0 || annotation.height <= 0
    ))) throw new BrowserPilotError('internal_error', 'Screenshot annotations are invalid');
    if (annotations.length === 0) return media;

    const { frameTree } = await this.transport.send('Page.getFrameTree', {}, this.sessionId);
    const frameId = frameTree?.frame?.id;
    if (typeof frameId !== 'string' || !frameId) {
      throw new BrowserPilotError('internal_error', 'Chrome returned an invalid annotation frame');
    }
    const { executionContextId } = await this.transport.send('Page.createIsolatedWorld', {
      frameId,
      worldName: 'browser-pilot.screenshot-annotation.v1',
      grantUniveralAccess: false,
    }, this.sessionId);
    if (!Number.isSafeInteger(executionContextId) || Number(executionContextId) <= 0) {
      throw new BrowserPilotError('internal_error', 'Chrome returned an invalid annotation execution context');
    }
    const { result, exceptionDetails } = await this.transport.send('Runtime.evaluate', {
      expression: annotationScript(Buffer.from(media.bytes).toString('base64'), annotations, viewport),
      returnByValue: true,
      awaitPromise: true,
      contextId: executionContextId,
    }, this.sessionId);
    if (exceptionDetails || typeof result?.value !== 'string') {
      throw new BrowserPilotError(
        'internal_error',
        exceptionDetails?.exception?.description || exceptionDetails?.text || 'Chrome failed to annotate screenshot',
      );
    }
    const prefix = 'data:image/png;base64,';
    if (!result.value.startsWith(prefix)) {
      throw new BrowserPilotError('internal_error', 'Chrome returned invalid annotated screenshot data');
    }
    const bytes = Buffer.from(result.value.slice(prefix.length), 'base64');
    if (bytes.byteLength === 0) {
      throw new BrowserPilotError('internal_error', 'Chrome returned an empty annotated screenshot');
    }
    return { ...media, bytes };
  }
}
