/**
 * WhisperSetupPrompt — the first-launch "download the recommended model?"
 * bar (`stores/whisper-setup.ts`).
 *
 * The same non-modal bottom bar as ExternalLinkPrompt: it dims nothing and
 * blocks nothing, and one click either starts the download (progress shows
 * in place) or sends it away for good. A projection of two stores — the
 * setup store says whether it is up, the models store owns the download.
 */

import { downloadPercent, formatBytes, recommendedModel } from '../../core/whisper-models';
import { uiStore } from '../stores/ui';
import { useWhisperModels, whisperModelsStore } from '../stores/whisper-models';
import { useWhisperSetup, whisperSetupStore } from '../stores/whisper-setup';

export function WhisperSetupPrompt() {
  const visible = useWhisperSetup((s) => s.visible);
  const download = useWhisperModels((s) => s.download);
  const model = useWhisperModels((s) => s.models.find((m) => m.id === recommendedModel()));
  if (!visible || !model) {
    return null;
  }
  const setup = () => whisperSetupStore.getState();
  const own = download.kind !== 'idle' && download.id === model.id ? download : null;
  const running = own?.kind === 'downloading' || own?.kind === 'verifying';
  const percent = own ? downloadPercent(own) : null;

  let text: string;
  let detail: string;
  if (running) {
    text = 'Downloading the dictation model…';
    detail =
      own.kind === 'verifying'
        ? 'Verifying'
        : percent === null
          ? formatBytes(model.bytes)
          : `${percent}% of ${formatBytes(model.bytes)}`;
  } else if (own?.kind === 'done') {
    text = 'Offline dictation is ready.';
    detail = 'In Review mode, press and hold on a line and talk.';
  } else if (own?.kind === 'failed' || own?.kind === 'cancelled') {
    text = own.kind === 'failed' ? 'The download did not finish.' : 'Download paused.';
    detail = 'Settings › Voice notes can resume it any time.';
  } else {
    text = 'Set up offline dictation?';
    detail = `Downloads the ${model.label} speech model (${formatBytes(model.bytes)}) once. Voice notes then work on this computer with no internet.`;
  }

  return (
    <div className="external-link-prompt whisper-setup-prompt" role="status" aria-live="polite">
      <div className="external-link-prompt-text">
        <span className="external-link-prompt-warning">{text}</span>
        <span className="whisper-setup-prompt-detail">{detail}</span>
        {running && (
          <div
            className="settings-progress whisper-setup-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
          >
            <div
              className={`settings-progress-bar${percent === null ? ' settings-progress-indeterminate' : ''}`}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
        )}
      </div>
      {running ? (
        <button
          className="external-link-prompt-button"
          onClick={() => whisperModelsStore.getState().cancelDownload()}
        >
          Cancel
        </button>
      ) : own ? (
        <>
          {own.kind !== 'done' && (
            <button
              className="external-link-prompt-button"
              onClick={() => {
                setup().decline();
                uiStore.getState().openSettings('voice');
              }}
            >
              Open settings
            </button>
          )}
          <button className="external-link-prompt-button" onClick={() => setup().decline()}>
            Close
          </button>
        </>
      ) : (
        <>
          <button
            className="external-link-prompt-button external-link-prompt-open"
            autoFocus
            onClick={() => void setup().accept()}
          >
            Download
          </button>
          <button className="external-link-prompt-button" onClick={() => setup().decline()}>
            Not now
          </button>
        </>
      )}
    </div>
  );
}
