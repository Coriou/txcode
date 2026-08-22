# Notifications

T3 Code can notify you when a thread needs your attention — even while you are working in
another window or on another thread. Notifications are off by default; you choose exactly which
events to hear about.

## What You Can Be Notified About

Open **Settings → General → Notifications** and turn on any of these:

- **Turn completions** – an agent finished working on a turn
- **Failures** – a turn stopped with an error
- **Approval requests** – a turn is paused and waiting for your approval
- **Input requests** – a turn is waiting for you to answer a question

## Focus Rules

The **Focus rule** setting controls when notifications appear relative to what you're looking at:

- **Always** – notify even if you're already viewing that exact thread
- **When unfocused** – notify only when the T3 Code window isn't focused
- **When unfocused or viewing another thread** – notify whenever you're away from the window or
  looking at a different thread (the default)

## Desktop

On the desktop app, notifications use your operating system's native notifications. Clicking one
brings the existing T3 Code window to the front and opens the thread. If nothing appears, check
that T3 Code is allowed to send notifications in your system settings.

## Browser

In the browser, T3 Code uses your browser's notification support. The first time you enable a
toggle, your browser asks for permission — accept it and you're set.

If you previously blocked notifications for the site, enabling a toggle shows a "Notifications
blocked" message instead of the prompt. To unblock:

1. Open your browser's site settings for the T3 Code page (usually via the icon in the address bar)
2. Set **Notifications** to **Allow**
3. Reload the page and toggle the setting again

## Mobile

Mobile devices receive push notifications through relay push settings and are not controlled by
these toggles. Configure them from your mobile app's notification settings.

## Good to Know

- **Provider-independent** – notifications work identically no matter which model provider a
  thread uses, because T3 Code derives them itself from thread activity.
- **Quiet by design** – bursts of events are collapsed into a single summary notification, and
  rapid-fire events are throttled so you don't get flooded.
