import Modal from '@app/components/Common/Modal';
import {
  DISMISS_KEY,
  decideNotifyPrompt,
  type NotifyPromptDecision,
} from '@app/components/NotifyPrompt/decide';
import Toast from '@app/components/Toast';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import {
  verifyAndResubscribePushSubscription,
  verifyPushSubscription,
} from '@app/utils/pushSubscriptionHelpers';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.NotifyPrompt', {
  title: "Get a notification when it's ready?",
  body: "We'll let you know on this device when something you asked for is ready to watch.",
  turnOn: 'Turn on',
  notNow: 'Not now',
  turnedOn: 'Notifications are on for this device.',
  turnOnFailed:
    "Couldn't turn on notifications. You can try again in Settings.",
  iosTitle: 'Get notified on your iPhone or iPad',
  iosIntro:
    'Apple only allows notifications for sites added to the Home Screen.',
  iosStep1: 'Tap the Share button, then "Add to Home Screen".',
  iosStep2: 'Open the site from the new icon on your Home Screen.',
  gotIt: 'Got it',
});

// Fired after something is asked for. Anything can dispatch it.
export const NOTIFY_PROMPT_EVENT = 'levac:ask-notify-prompt';

export const requestNotifyPrompt = () => {
  window.dispatchEvent(new CustomEvent(NOTIFY_PROMPT_EVENT));
};

const isIosDevice = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  // iPadOS reports itself as a Mac but has a touch screen.
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isStandaloneApp = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

const readDismissedAt = (): number | null => {
  try {
    const value = Number(localStorage.getItem(DISMISS_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
};

// getPushSubscription waits for a service worker that may never register.
const withTimeout = <T,>(promise: Promise<T>, fallback: T, ms = 4000) =>
  Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);

// Mounted once in Layout. Watches for successful requests / library adds and
// then asks the person to turn on web push, through the upstream helpers.
const NotifyPrompt = () => {
  const intl = useIntl();
  const { user } = useUser();
  const { currentSettings } = useSettings();
  const [view, setView] = useState<'prompt' | 'ios-hint' | null>(null);
  const checking = useRef(false);
  const latest = useRef({ user, currentSettings });
  latest.current = { user, currentSettings };

  const showToast = useCallback(
    (appearance: 'success' | 'error', text: string) => {
      toast.custom(
        (t) => (
          <Toast
            appearance={appearance}
            onDismiss={() => toast.dismiss(t.id)}
            transitionState={t.visible ? 'entered' : 'exiting'}
          >
            {text}
          </Toast>
        ),
        { duration: 4000 }
      );
    },
    []
  );

  const subscribe = useCallback(async () => {
    const { user: me, currentSettings: settings } = latest.current;
    const ok = await verifyAndResubscribePushSubscription(me?.id, settings);
    if (!ok) throw new Error('Subscription failed');
    // Same flag the Settings page sets, so ServiceWorkerSetup keeps it fresh.
    localStorage.setItem('pushNotificationsEnabled', 'true');
  }, []);

  const check = useCallback(async () => {
    const { user: me, currentSettings: settings } = latest.current;
    if (checking.current || !me?.id) return;
    checking.current = true;
    try {
      const pushSupported =
        'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window &&
        !!settings.enablePushRegistration &&
        !!settings.vapidPublic;
      const permission =
        'Notification' in window ? Notification.permission : 'denied';
      const ios = isIosDevice();
      const standalone = isStandaloneApp();
      const dismissedAt = readDismissedAt();
      const needsSubscriptionCheck =
        pushSupported && permission !== 'denied' && (!ios || standalone);
      const hasSubscription = needsSubscriptionCheck
        ? await withTimeout(verifyPushSubscription(me.id, settings), true)
        : false;

      const decision: NotifyPromptDecision = decideNotifyPrompt({
        pushSupported,
        permission,
        hasSubscription,
        isIos: ios,
        isStandalone: standalone,
        dismissedAt,
        now: Date.now(),
      });

      if (decision === 'prompt' || decision === 'ios-hint') {
        setView(decision);
      } else if (decision === 'subscribe') {
        try {
          await subscribe();
        } catch {
          // Quiet on purpose: nobody asked for this, so nobody needs the error.
        }
      }
    } finally {
      checking.current = false;
    }
  }, [subscribe]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAsked = () => {
      // Let the request modal close first.
      clearTimeout(timer);
      timer = setTimeout(check, 1500);
    };
    window.addEventListener(NOTIFY_PROMPT_EVENT, onAsked);

    // A successful request or "Add to My Library" fires the event, so the
    // upstream request modals and RequestButton need no changes.
    const interceptor = axios.interceptors.response.use((response) => {
      const { method, url, data } = response.config;
      if (method?.toLowerCase() === 'post' && url) {
        const path = url.split('?')[0];
        if (path === '/api/v1/request') {
          requestNotifyPrompt();
        } else if (path === '/api/v1/request/fanout') {
          try {
            const body = typeof data === 'string' ? JSON.parse(data) : data;
            if (body?.desiredState === 'present' && !body?.owner) {
              requestNotifyPrompt();
            }
          } catch {
            // Unreadable body: not worth prompting for.
          }
        }
      }
      return response;
    });

    return () => {
      clearTimeout(timer);
      window.removeEventListener(NOTIFY_PROMPT_EVENT, onAsked);
      axios.interceptors.response.eject(interceptor);
    };
  }, [check]);

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // Private mode: it will just ask again next time.
    }
    setView(null);
  };

  const turnOn = async () => {
    setView(null);
    try {
      const result = await Notification.requestPermission();
      if (result !== 'granted') {
        // Chose "Block" or closed it: treat like Not now so we don't nag.
        if (result === 'default') dismiss();
        return;
      }
      await subscribe();
      showToast('success', intl.formatMessage(messages.turnedOn));
    } catch {
      showToast('error', intl.formatMessage(messages.turnOnFailed));
    }
  };

  return (
    <Transition
      as="div"
      show={view !== null}
      enter="transition-opacity duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      {view === 'prompt' && (
        <Modal
          title={intl.formatMessage(messages.title)}
          okText={intl.formatMessage(messages.turnOn)}
          cancelText={intl.formatMessage(messages.notNow)}
          onOk={turnOn}
          onCancel={dismiss}
          dialogClass="sm:max-w-md"
        >
          <p className="mt-4 text-gray-300" data-testid="notify-prompt">
            {intl.formatMessage(messages.body)}
          </p>
        </Modal>
      )}
      {view === 'ios-hint' && (
        <Modal
          title={intl.formatMessage(messages.iosTitle)}
          okText={intl.formatMessage(messages.gotIt)}
          onOk={dismiss}
          onCancel={dismiss}
          dialogClass="sm:max-w-md"
        >
          <div className="mt-4 text-gray-300" data-testid="notify-ios-hint">
            <p>{intl.formatMessage(messages.iosIntro)}</p>
            <ol className="mt-3 list-decimal space-y-1 pl-5">
              <li>{intl.formatMessage(messages.iosStep1)}</li>
              <li>{intl.formatMessage(messages.iosStep2)}</li>
            </ol>
          </div>
        </Modal>
      )}
    </Transition>
  );
};

export default NotifyPrompt;
