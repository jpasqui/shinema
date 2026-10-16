import { useEffect, useRef, useState } from 'react';
import type { LibraryDescriptor } from '../../../packages/contracts/libraries.ts';
import {
  defaultTopNavigation,
  maxTopNavigationEntries,
  moveTopNavigation,
  orderedTopNavigation,
  parseTopNavigation,
  recoverTopNavigation,
  topNavigationStorageKey,
  visibleTopNavigation,
} from '../../../packages/contracts/navigation.ts';
import type {
  TopNavigationDestination,
  TopNavigationEntry,
  TopNavigationPreferences,
} from '../../../packages/contracts/navigation.ts';
import './navigation.css';

function readNavigation() {
  try {
    return recoverTopNavigation(localStorage.getItem(topNavigationStorageKey));
  } catch {
    return defaultTopNavigation();
  }
}
function destinationValue(destination: TopNavigationDestination): string {
  return destination.kind === 'library'
    ? `library:${destination.libraryId}`
    : destination.kind;
}

export function TopNavigation({
  libraries,
  librariesReady = true,
  browsing,
  activeLibraryId,
  onNavigate,
  requestsActive = false,
  onRequests,
}: {
  libraries: readonly LibraryDescriptor[];
  librariesReady?: boolean;
  browsing: boolean;
  activeLibraryId?: string;
  onNavigate: (destination: TopNavigationDestination) => void;
  requestsActive?: boolean;
  onRequests?: () => void;
}) {
  const [preferences, setPreferences] = useState(readNavigation);
  const [draft, setDraft] = useState(preferences);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState('');
  const [invalid, setInvalid] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (
        event.storageArea === localStorage &&
        event.key === topNavigationStorageKey
      )
        setPreferences(recoverTopNavigation(event.newValue));
    };
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);
  useEffect(() => {
    if (editing) dialog.current?.showModal();
  }, [editing]);
  const close = () => {
    dialog.current?.close();
    setEditing(false);
    settingsButton.current?.focus();
  };
  const update = (id: string, patch: Partial<TopNavigationEntry>) => {
    setDraft((current) => ({
      ...current,
      entries: current.entries.map((entry) =>
        entry.id === id ? { ...entry, ...patch } : entry,
      ),
    }));
    setMessage('');
    setInvalid(false);
  };
  const save = (value: TopNavigationPreferences) => {
    try {
      const next = parseTopNavigation(value);
      setPreferences(next);
      setDraft(next);
      setInvalid(false);
      try {
        localStorage.setItem(topNavigationStorageKey, JSON.stringify(next));
        setMessage('Navigation saved on this browser.');
      } catch {
        setMessage(
          'Changes are active for this session. Browser storage is unavailable, so they will reset after restart.',
        );
      }
    } catch (error) {
      setInvalid(true);
      setMessage(
        error instanceof Error ? error.message : 'Check navigation settings.',
      );
    }
  };
  const add = () => {
    let number = 1;
    const ids = new Set(draft.entries.map((entry) => entry.id));
    const labels = new Set(draft.entries.map((entry) => entry.label));
    while (ids.has(`item-${number}`) || labels.has(`New item ${number}`))
      number++;
    setDraft({
      version: 1,
      entries: [
        ...orderedTopNavigation(draft).map((entry, order) => ({
          ...entry,
          order,
        })),
        {
          id: `item-${number}`,
          label: `New item ${number}`,
          destination: { kind: 'browse' },
          order: draft.entries.length,
          visible: true,
        },
      ],
    });
    setMessage('New item added. Choose a label and destination, then save.');
    setInvalid(false);
  };
  const entries = visibleTopNavigation(preferences, libraries);
  // Discovery may reveal a saved target after the first paint. Its physical
  // slot belongs to the local order even while the target is unavailable.
  // Canonical visibility still decides whether it is an actionable button.
  const available = new Set(entries.map((entry) => entry.id));
  const slots = orderedTopNavigation(preferences).filter(
    (entry) => entry.visible,
  );
  const activeEntry = browsing
    ? (entries.find(
        (entry) =>
          entry.destination.kind === 'library' &&
          entry.destination.libraryId === activeLibraryId,
      ) ?? entries.find((entry) => entry.destination.kind === 'browse'))
    : undefined;
  return (
    <>
      <nav className="top-navigation" aria-label="Main navigation">
        <div className="top-navigation-items">
          {slots.map((entry) =>
            available.has(entry.id) ? (
              <button
                key={entry.id}
                data-navigation-slot={entry.id}
                className={`nav-link${entry.id === activeEntry?.id ? ' active' : ''}`}
                aria-current={entry.id === activeEntry?.id ? 'page' : undefined}
                disabled={
                  entry.destination.kind === 'library' && !librariesReady
                }
                onClick={() => {
                  if (entry.destination.kind !== 'library' || librariesReady)
                    onNavigate(entry.destination);
                }}
              >
                {entry.label}
              </button>
            ) : (
              <span
                key={entry.id}
                className="nav-link navigation-placeholder"
                data-navigation-slot={entry.id}
                aria-hidden="true"
              />
            ),
          )}
          {onRequests && (
            <button
              data-requests-slot
              className={`nav-link${requestsActive ? ' active' : ''}`}
              aria-current={requestsActive ? 'page' : undefined}
              onClick={onRequests}
            >
              Requests
            </button>
          )}
        </div>
        <button
          ref={settingsButton}
          className="nav-link navigation-settings-button"
          aria-label="Navigation settings"
          aria-haspopup="dialog"
          onClick={() => {
            setDraft(parseTopNavigation(preferences));
            setMessage('');
            setInvalid(false);
            setEditing(true);
          }}
        >
          Settings
        </button>
      </nav>
      {editing && (
        <dialog
          className="navigation-dialog"
          ref={dialog}
          aria-labelledby="navigation-settings-title"
          aria-describedby="navigation-settings-description"
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          onClose={() => setEditing(false)}
          onKeyDown={(event) => {
            // The app also uses Escape to leave details; keep modal Escape local.
            if (event.key === 'Escape') event.stopPropagation();
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              save(draft);
            }}
          >
            <div className="navigation-dialog-heading">
              <h2 id="navigation-settings-title">Navigation on this browser</h2>
              <button
                className="text-button"
                type="button"
                onClick={close}
                autoFocus
              >
                Close
              </button>
            </div>
            <p id="navigation-settings-description">
              Rename top bar items, choose what they open, and arrange or hide
              them. These preferences stay on this browser. Settings always
              remains available.
            </p>
            {orderedTopNavigation(draft).map((entry, index) => {
              const destination = entry.destination;
              const unavailable =
                destination.kind === 'library' &&
                !libraries.some(
                  (library) => library.id === destination.libraryId,
                );
              return (
                <fieldset key={entry.id}>
                  <legend>Item {index + 1}</legend>
                  <div className="navigation-fields">
                    <label htmlFor={`nav-label-${entry.id}`}>
                      Display label
                      <input
                        id={`nav-label-${entry.id}`}
                        value={entry.label}
                        required
                        maxLength={160}
                        onChange={(event) =>
                          update(entry.id, { label: event.target.value })
                        }
                      />
                    </label>
                    <label htmlFor={`nav-destination-${entry.id}`}>
                      Opens
                      <select
                        id={`nav-destination-${entry.id}`}
                        value={destinationValue(destination)}
                        onChange={(event) => {
                          const value = event.target.value;
                          update(entry.id, {
                            destination: value.startsWith('library:')
                              ? { kind: 'library', libraryId: value.slice(8) }
                              : {
                                  kind: value as
                                    'browse' | 'search' | 'settings',
                                },
                          });
                        }}
                      >
                        <option value="browse">Browse libraries</option>
                        <option value="search">Search current library</option>
                        <option value="settings">Library settings</option>
                        {unavailable && (
                          <option
                            value={destinationValue(destination)}
                            disabled
                          >
                            Unavailable library (
                            {destination.kind === 'library'
                              ? destination.libraryId
                              : ''}
                            )
                          </option>
                        )}
                        {libraries.map((library) => (
                          <option
                            key={library.id}
                            value={`library:${library.id}`}
                          >
                            {library.name}
                            {library.visible ? '' : ' (hidden by server)'}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {destination.kind === 'library' &&
                    (unavailable ||
                      !libraries.find(
                        (library) => library.id === destination.libraryId,
                      )?.visible) && (
                      <p className="navigation-help">
                        This item stays saved and will appear when the library
                        is available and visible again.
                      </p>
                    )}
                  <div className="navigation-item-actions">
                    <label className="navigation-visible">
                      <input
                        type="checkbox"
                        checked={entry.visible}
                        onChange={(event) =>
                          update(entry.id, { visible: event.target.checked })
                        }
                      />
                      Show in top bar
                    </label>
                    <button
                      className="text-button"
                      type="button"
                      disabled={index === 0}
                      aria-label={`Move item ${index + 1} up`}
                      onClick={() =>
                        setDraft((current) =>
                          moveTopNavigation(current, entry.id, -1),
                        )
                      }
                    >
                      Move up
                    </button>
                    <button
                      className="text-button"
                      type="button"
                      disabled={index === draft.entries.length - 1}
                      aria-label={`Move item ${index + 1} down`}
                      onClick={() =>
                        setDraft((current) =>
                          moveTopNavigation(current, entry.id, 1),
                        )
                      }
                    >
                      Move down
                    </button>
                    <button
                      className="text-button"
                      type="button"
                      aria-label={`Remove item ${index + 1}`}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          entries: current.entries.filter(
                            (item) => item.id !== entry.id,
                          ),
                        }))
                      }
                    >
                      Remove
                    </button>
                  </div>
                </fieldset>
              );
            })}
            {!draft.entries.length && (
              <p>
                No top bar items. Add an item or reset to the defaults; Settings
                remains available.
              </p>
            )}
            <div className="navigation-editor-actions">
              <button
                type="button"
                className="text-button"
                disabled={draft.entries.length >= maxTopNavigationEntries}
                onClick={add}
              >
                Add navigation item
              </button>
              <button type="submit" className="primary">
                Save navigation
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => save(defaultTopNavigation())}
              >
                Reset navigation defaults
              </button>
            </div>
            <p
              className="navigation-message"
              role={invalid ? 'alert' : 'status'}
            >
              {message}
            </p>
            <hr />
            <button
              type="button"
              className="text-button"
              onClick={() => {
                close();
                onNavigate({ kind: 'settings' });
              }}
            >
              Open library settings
            </button>
            <p className="navigation-help">
              Server library names and sources apply to every client. Hiding a
              navigation item does not restrict access to media.
            </p>
          </form>
        </dialog>
      )}
    </>
  );
}
