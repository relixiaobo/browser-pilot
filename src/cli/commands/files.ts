import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { BrowserPilotError, invalidArgument } from '../../protocol/errors.js';
import type { ArtifactDescriptor, JsonValue } from '../../protocol/model.js';
import { serializeStructuralText } from '../../structural-text.js';
import { artifactFileResult, artifactFrom, outputPath } from '../artifacts.js';
import type { CliCommandContext } from '../context.js';
import { parsePositiveInteger, parseRef } from '../parse.js';

export function register(program: Command, ctx: CliCommandContext): void {
  const {
    action,
    requireCompatibility,
    withTarget: withCliTarget,
  } = ctx;
  const { emit, emitObservation, useJson } = ctx.output;

program.command('upload <filepath>')
  .description('Upload file (auto-finds <input type="file"> on the page)')
  .option('--nth <n>', 'which file input to use if multiple exist', '1')
  .addHelpText('after', '\nAuto-detects file inputs on the page. No ref needed.\n\nExamples:\n  bp upload ./photo.jpg\n  bp upload /tmp/resume.pdf\n  bp upload ./doc.pdf --nth 2    # if multiple file inputs')
  .action(action(async (filepath, opts) => {
    const absPath = resolvePath(filepath);
    if (!existsSync(absPath)) throw invalidArgument(`File not found: ${absPath}`, 'filepath');
    const inputIndex = parsePositiveInteger(
      opts.nth,
      '--nth must be a positive integer',
      'nth',
    );
    await withCliTarget(async (client, target) => {
      const artifact = await client.importArtifact(absPath);
      try {
        const result = await client.callTool('browser.upload', {
          artifactId: artifact.id,
          inputIndex,
          observationLimit: 50,
        }, target.targetId);
        emitObservation(result);
      } finally {
        await client.releaseArtifact(artifact.id).catch(() => {});
      }
    });
  }));

program.command('downloads')
  .description('List completed downloads available to this Agent namespace')
  .action(action(async () => {
    const artifacts = await (await requireCompatibility()).listArtifacts(['download']);
    const downloads = artifacts.map((artifact, index) => ({
      index: index + 1,
      id: artifact.id,
      fileName: artifact.fileName,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.byteSize,
      createdAt: artifact.createdAt,
      expiresAt: artifact.expiresAt,
    }));
    if (useJson()) {
      emit({ ok: true, downloads });
    } else if (downloads.length === 0) {
      console.log('No completed downloads.');
    } else {
      for (const download of downloads) {
        console.log(`${download.index}  ${serializeStructuralText(download.fileName ?? download.id)}  ${download.sizeBytes} bytes`);
      }
    }
  }));

program.command('download <selector> [filename]')
  .description('Export one completed download to a local file')
  .action(action(async (selector, filename) => {
    const client = await requireCompatibility();
    const artifacts = await client.listArtifacts(['download']);
    const artifact = /^\d+$/.test(selector)
      ? artifacts[Number(selector) - 1]
      : artifacts.find(candidate => candidate.id === selector);
    if (!artifact) {
      throw new BrowserPilotError('artifact_not_found', 'Download was not found for this Agent namespace', {
        context: { field: 'selector' },
      });
    }
    const fallbackName = artifact.fileName ? basename(artifact.fileName) : `download-${artifact.createdAt}`;
    const file = outputPath(filename ?? fallbackName);
    await client.exportArtifact(artifact.id, file);
    await client.releaseArtifact(artifact.id).catch(() => {});
    emit({ ok: true, ...artifactFileResult(artifact, file) }, `\u2713 Download saved to ${file}`);
  }));

// ─── screenshot ─────────────────────────────────────

program.command('screenshot [filename]')
  .description('Capture screenshot')
  .option('-f, --full', 'capture full page')
  .option('--selector <sel>', 'capture specific element')
  .option('--annotate [refs]', 'draw Observation ref boxes; optionally comma-separated refs')
  .addHelpText('after', '\nExamples:\n  bp screenshot\n  bp screenshot page.png\n  bp screenshot --full\n  bp screenshot --selector ".chart"\n  bp screenshot page.png --annotate\n  bp screenshot page.png --annotate 1,3,8')
  .action(action(async (filename, opts) => {
    if (opts.annotate !== undefined && (opts.full || opts.selector)) {
      throw invalidArgument('--annotate cannot be combined with --full or --selector', 'annotate');
    }
    await withCliTarget(async (client, target) => {
      let annotations: Record<string, JsonValue> | undefined;
      if (opts.annotate !== undefined) {
        const refs = typeof opts.annotate === 'string'
          ? opts.annotate.split(',').map((value: string) => parseRef(value.trim()))
          : undefined;
        annotations = {
          observationId: await client.latestObservation(target.targetId),
          ...(refs ? { refs } : {}),
        };
      }
      const result = await client.callTool('browser.capture', {
        fullPage: opts.full,
        ...(opts.selector ? { selector: opts.selector } : {}),
        ...(annotations ? { annotations } : {}),
        includeOriginal: true,
      }, target.targetId);
      const artifact = artifactFrom(result);
      const file = filename ?? `screenshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}.png`;
      const destination = outputPath(file);
      try {
        await client.exportArtifact(artifact.id, destination);
      } finally {
        await client.releaseArtifact(artifact.id).catch(() => {});
        if (result.preview && typeof result.preview === 'object' && !Array.isArray(result.preview)) {
          const preview = result.preview as unknown as ArtifactDescriptor;
          await client.releaseArtifact(preview.id).catch(() => {});
        }
      }
      emit({
        ok: true,
        ...artifactFileResult(artifact, destination),
        ...(typeof result.annotationCount === 'number' ? { annotationCount: result.annotationCount } : {}),
      }, `\u2713 Screenshot saved to ${destination}`);
    });
  }));

// ─── pdf ────────────────────────────────────────────

program.command('pdf [filename]')
  .description('Save page as PDF')
  .option('--landscape', 'landscape orientation')
  .addHelpText('after', '\nExamples:\n  bp pdf\n  bp pdf report.pdf\n  bp pdf report.pdf --landscape')
  .action(action(async (filename, opts) => {
    await withCliTarget(async (client, target) => {
      const result = await client.callTool('browser.pdf', {
        ...(opts.landscape ? { landscape: true } : {}),
      }, target.targetId);
      const artifact = artifactFrom(result);
      const file = filename ?? `page-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}.pdf`;
      const destination = outputPath(file);
      try {
        await client.exportArtifact(artifact.id, destination);
      } finally {
        await client.releaseArtifact(artifact.id).catch(() => {});
      }
      emit({ ok: true, ...artifactFileResult(artifact, destination) }, `\u2713 PDF saved to ${destination}`);
    });
  }));

}
