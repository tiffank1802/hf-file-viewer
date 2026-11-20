export const FINDER_COMMAND_EVENT = 'enise-finder-command';
export const CHECK_UPDATE_EVENT = 'enise-check-updates';

export function requestUpdateCheck() {
  window.dispatchEvent(new Event(CHECK_UPDATE_EVENT));
}

export function sendFinderCommand(command) {
  window.dispatchEvent(new CustomEvent(FINDER_COMMAND_EVENT, { detail: command }));
}
