// Keep the opening announcement on the dialog itself. Focusing the first icon
// button also opens its tooltip before the user has interacted with the dialog.
export function focusDialogContent(event) {
  event.preventDefault();
  event.currentTarget.focus({ preventScroll: true });
}
