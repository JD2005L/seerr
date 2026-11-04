import Button from '@app/components/Common/Button';
import Toast from '@app/components/Toast';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { toast } from 'react-hot-toast';
import type { LibraryToastView } from './fanoutOptions';

type Handlers = {
  onRetry: () => void;
  onNotify: () => void;
  onDismiss: () => void;
};

// One live message per title and library. Showing it again with the same id
// updates it in place, so it follows the copy from asked to done.
export function showLibraryToast(
  id: string,
  view: LibraryToastView,
  handlers: Handlers
) {
  toast.custom(
    (t) => (
      <Toast
        appearance={view.appearance}
        onDismiss={() => {
          toast.dismiss(t.id);
          handlers.onDismiss();
        }}
        transitionState={t.visible ? 'entered' : 'exiting'}
      >
        <div data-testid="library-toast">
          <div className="flex items-center gap-2 font-medium">
            {view.busy && (
              <ArrowPathIcon className="h-4 w-4 flex-shrink-0 animate-spin" />
            )}
            <span>{view.title}</span>
          </div>
          {view.detail && (
            <p className="mt-1 text-sm text-gray-300">{view.detail}</p>
          )}
          {view.notes && view.notes.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-sm text-gray-400">
              {view.notes.map((note, index) => (
                <li key={`note-${index}`}>PVIBot: {note}</li>
              ))}
            </ul>
          )}
          {view.actions && view.actions.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {view.actions.includes('retry') && (
                <Button
                  buttonType="primary"
                  buttonSize="sm"
                  onClick={() => handlers.onRetry()}
                >
                  Try Again
                </Button>
              )}
              {view.actions.includes('notify') && (
                <Button
                  buttonType="warning"
                  buttonSize="sm"
                  onClick={() => handlers.onNotify()}
                  data-testid="notify-pvibot"
                >
                  Notify PVIBot
                </Button>
              )}
            </div>
          )}
        </div>
      </Toast>
    ),
    { id, duration: view.duration ?? Infinity }
  );
}

export function hideLibraryToast(id: string) {
  toast.dismiss(id);
}
