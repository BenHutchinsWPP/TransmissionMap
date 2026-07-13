// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

import { showTribalDisclaimer } from './tribal-disclaimer.js';

// jsdom ships <dialog> without the modal methods. The module reads `open` and relies
// on close() firing a "close" event, so the stand-in has to do both.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close     = function () {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}

let tribal: HTMLDialogElement, main: HTMLDialogElement;

beforeEach(() => {
  document.body.innerHTML = `
    <dialog id="tribalDisclaimerDialog"></dialog>
    <dialog id="disclaimerDialog"></dialog>
  `;
  tribal = document.getElementById('tribalDisclaimerDialog') as HTMLDialogElement;
  main   = document.getElementById('disclaimerDialog') as HTMLDialogElement;
});

describe('showTribalDisclaimer', () => {
  it('opens the dialog', () => {
    showTribalDisclaimer();
    expect(tribal.open).toBe(true);
  });

  it('opens again on every enable, even after a previous acknowledgement', () => {
    showTribalDisclaimer();
    tribal.close();
    expect(tribal.open).toBe(false);

    showTribalDisclaimer();
    expect(tribal.open).toBe(true);
  });

  it('does not stack on top of the open site-wide disclaimer', () => {
    main.showModal();

    showTribalDisclaimer();
    expect(tribal.open).toBe(false);
  });

  it('shows the deferred disclaimer once the site-wide disclaimer is dismissed', () => {
    main.showModal();
    showTribalDisclaimer();

    main.close();
    expect(tribal.open).toBe(true);
  });

  it('does not show a disclaimer that was never requested', () => {
    main.showModal();

    main.close();
    expect(tribal.open).toBe(false);
  });

  it('a double enable behind the site-wide disclaimer still opens exactly once', () => {
    main.showModal();
    showTribalDisclaimer();
    showTribalDisclaimer();

    // A second showModal() on an already-open dialog throws InvalidStateError; the
    // dlg.open guard is what keeps the deferred path from doing that.
    expect(() => main.close()).not.toThrow();
    expect(tribal.open).toBe(true);
  });
});
