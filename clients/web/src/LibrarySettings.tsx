import { useEffect, useRef, useState } from 'react';
import {
  builtinContentRegistry,
  contentTypeForLibrary,
  libraryContentSupport,
  parseLibraryConfiguration,
  visibleLibraries,
} from '../../../packages/contracts/index.ts';
import type {
  Libraries,
  LibraryConfigurationDocument,
  NavigationPreferences,
} from '../../../packages/contracts/index.ts';
import './library-settings.css';

export function LibrarySettings({
  document,
  preferences,
  onPreferences,
  onSaved,
  onClose,
}: {
  document: Libraries;
  preferences: NavigationPreferences;
  onPreferences: (value: NavigationPreferences) => void;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [token, setToken] = useState('');
  const [config, setConfig] = useState<LibraryConfigurationDocument | null>(
    null,
  );
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    heading.current?.scrollIntoView({ block: 'start' });
    return () => {
      ++request.current;
    };
  }, []);
  const ordered = visibleLibraries(document.libraries, {
    ...preferences,
    hidden: [],
  });
  const localMove = (id: string, delta: number) => {
    const ids = ordered.map((item) => item.id);
    const index = ids.indexOf(id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    onPreferences({ ...preferences, order: ids });
  };
  const load = async () => {
    const ticket = ++request.current;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/admin/libraries', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok)
        throw new Error(
          response.status === 403
            ? 'Library administration is disabled or the admin token is invalid.'
            : 'Could not load server settings.',
        );
      const value = parseLibraryConfiguration(await response.json());
      if (ticket === request.current) {
        setConfig(value);
        setMessage('Server settings loaded. Changes apply to every client.');
      }
    } catch (error) {
      if (ticket === request.current)
        setMessage(
          error instanceof Error ? error.message : 'Could not load settings.',
        );
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  };
  const save = async () => {
    if (!config) return;
    const ticket = ++request.current;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/admin/libraries', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          revision: config.revision,
          libraries: config.libraries,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? 'Settings changed elsewhere. Reload server settings before saving.'
            : response.status === 400
              ? 'Check names, unique IDs and source choices. No changes were saved.'
              : response.status === 403
                ? 'The admin token is invalid or administration is disabled.'
                : 'The save could not be confirmed. Reload settings to check the saved version.',
        );
      const value = parseLibraryConfiguration(await response.json());
      if (ticket === request.current) {
        setConfig(value);
        setMessage(
          'Server library settings saved. Playback progress is preserved.',
        );
        onSaved();
      }
    } catch (error) {
      if (ticket === request.current)
        setMessage(
          error instanceof Error ? error.message : 'Could not save settings.',
        );
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  };
  const edit = (
    index: number,
    patch: Partial<LibraryConfigurationDocument['libraries'][number]>,
  ) =>
    setConfig((current) =>
      current
        ? {
            ...current,
            libraries: current.libraries.map((item, i) =>
              i === index ? { ...item, ...patch } : item,
            ),
          }
        : null,
    );
  const reorder = (index: number, delta: number) =>
    setConfig((current) => {
      if (!current) return current;
      const libraries = [...current.libraries];
      const target = index + delta;
      if (target < 0 || target >= libraries.length) return current;
      [libraries[index], libraries[target]] = [
        libraries[target],
        libraries[index],
      ];
      return {
        ...current,
        libraries: libraries.map((item, order) => ({ ...item, order })),
      };
    });
  return (
    <section className="library-settings" aria-label="Library settings">
      <div className="section-heading">
        <h2 ref={heading} tabIndex={-1}>
          Library settings
        </h2>
        <button
          className="text-button"
          onClick={() => {
            ++request.current;
            setToken('');
            onClose();
          }}
        >
          Close settings
        </button>
      </div>
      <h3>Navigation on this browser</h3>
      <p>
        Choose which available libraries appear here. These preferences stay on
        this browser.
      </p>
      {ordered.map((item, index) => (
        <div className="navigation-setting" key={item.id}>
          <label>
            <input
              type="checkbox"
              checked={!preferences.hidden.includes(item.id)}
              onChange={(event) =>
                onPreferences({
                  ...preferences,
                  hidden: event.target.checked
                    ? preferences.hidden.filter((id) => id !== item.id)
                    : [...preferences.hidden, item.id],
                })
              }
            />
            {item.name}
          </label>
          <button
            className="text-button"
            aria-label={`Move ${item.name} up on this browser`}
            disabled={index === 0}
            onClick={() => localMove(item.id, -1)}
          >
            ↑
          </button>
          <button
            className="text-button"
            aria-label={`Move ${item.name} down on this browser`}
            disabled={index === ordered.length - 1}
            onClick={() => localMove(item.id, 1)}
          >
            ↓
          </button>
        </div>
      ))}
      <button
        className="text-button"
        onClick={() => onPreferences({ order: [], hidden: [] })}
      >
        Reset browser navigation
      </button>
      <hr />
      <h3>Server libraries</h3>
      <p>
        Names, content types, sources and default navigation apply to all
        clients.
      </p>
      <details>
        <summary>Development operator controls</summary>
        <p>
          This temporary control is for the server operator. Account sign-in and
          permissions are planned separately; personal navigation above needs no
          token.
        </p>
        <form
          className="admin-unlock"
          onSubmit={(event) => {
            event.preventDefault();
            void load();
          }}
        >
          <label>
            Admin token
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <button
            className="control-button"
            disabled={busy || token.length < 32}
          >
            Load server settings
          </button>
        </form>
        {config && (
          <div className="server-library-settings">
            <p>
              Source choices come from folders already approved by the server.
              New files are scanned after a server restart.
            </p>
            {config.libraries.map((item, index) => (
              <fieldset key={index} disabled={busy}>
                <legend>{item.name || 'New library'}</legend>
                <label>
                  Display name
                  <input
                    value={item.name}
                    maxLength={80}
                    onChange={(event) =>
                      edit(index, { name: event.target.value })
                    }
                  />
                </label>
                <label>
                  Stable library ID
                  <input
                    value={item.id}
                    disabled={document.libraries.some(
                      (existing) => existing.id === item.id,
                    )}
                    maxLength={48}
                    onChange={(event) =>
                      edit(index, { id: event.target.value })
                    }
                  />
                </label>
                <label>
                  Content type
                  <select
                    value={contentTypeForLibrary(item) ?? ''}
                    disabled={item.id === 'other'}
                    onChange={(event) =>
                      edit(index, {
                        contentTypeId: event.target.value || null,
                        mediaType: event.target.value || 'mixed',
                      })
                    }
                  >
                    <option value="">
                      Existing video formats (unrestricted)
                    </option>
                    {(
                      config.registry ?? builtinContentRegistry()
                    ).contentTypes.map((type) => (
                      <option
                        key={type.id}
                        value={type.id}
                        disabled={
                          type.availability !== 'available' &&
                          type.id !== contentTypeForLibrary(item)
                        }
                      >
                        {type.name}
                        {type.availability === 'available'
                          ? ''
                          : ' (unavailable)'}
                      </option>
                    ))}
                    {contentTypeForLibrary(item) !== null &&
                      !(
                        config.registry ?? builtinContentRegistry()
                      ).contentTypes.some(
                        (type) => type.id === contentTypeForLibrary(item),
                      ) && (
                        <option value={contentTypeForLibrary(item)!}>
                          {contentTypeForLibrary(item)} (unavailable)
                        </option>
                      )}
                  </select>
                </label>
                {!libraryContentSupport(item, config.registry).supported && (
                  <p role="status">
                    {libraryContentSupport(item, config.registry).reason}
                  </p>
                )}
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={item.visible}
                    onChange={(event) =>
                      edit(index, { visible: event.target.checked })
                    }
                  />
                  Show in default navigation
                </label>
                {item.id === 'other' ? (
                  <p>
                    Includes indexed files that do not match another source.
                  </p>
                ) : (
                  <label>
                    Source folders
                    <select
                      multiple
                      aria-label={`Source folders for ${item.name}`}
                      value={item.sourceFolders}
                      onChange={(event) =>
                        edit(index, {
                          sourceFolders: Array.from(
                            event.target.selectedOptions,
                            (option) => option.value,
                          ),
                        })
                      }
                    >
                      {[
                        ...new Set([
                          ...config.availableFolders,
                          ...item.sourceFolders,
                        ]),
                      ].map((folder) => (
                        <option key={folder} value={folder}>
                          {folder === '.' ? 'Approved source root' : folder}
                          {config.availableFolders.includes(folder)
                            ? ''
                            : ' (not in current scan)'}
                        </option>
                      ))}
                    </select>
                    <small>
                      Use Ctrl / Command to select multiple folders. Nested
                      sources take precedence.
                    </small>
                    <button
                      className="text-button"
                      onClick={() => edit(index, { sourceFolders: [] })}
                    >
                      Clear source folders
                    </button>
                  </label>
                )}
                <div className="settings-actions">
                  <button
                    className="text-button"
                    disabled={index === 0}
                    onClick={() => reorder(index, -1)}
                  >
                    Move up
                  </button>
                  <button
                    className="text-button"
                    disabled={index === config.libraries.length - 1}
                    onClick={() => reorder(index, 1)}
                  >
                    Move down
                  </button>
                  {item.id !== 'other' && (
                    <button
                      className="text-button"
                      onClick={() =>
                        setConfig({
                          ...config,
                          libraries: config.libraries.filter(
                            (_, i) => i !== index,
                          ),
                        })
                      }
                    >
                      Remove library
                    </button>
                  )}
                </div>
              </fieldset>
            ))}
            <div className="settings-actions">
              <button
                className="text-button"
                disabled={busy || config.libraries.length >= 64}
                onClick={() =>
                  setConfig({
                    ...config,
                    libraries: [
                      ...config.libraries,
                      {
                        id: `library-${Date.now().toString(36)}`,
                        name: 'New library',
                        contentTypeId: null,
                        mediaType: 'mixed',
                        visible: true,
                        order: config.libraries.length,
                        sourceFolders: [],
                      },
                    ],
                  })
                }
              >
                Add library
              </button>
              <button
                className="control-button"
                disabled={busy}
                onClick={() => void save()}
              >
                Save server libraries
              </button>
            </div>
          </div>
        )}
        <p role="status" className="notice">
          {message}
        </p>
      </details>
    </section>
  );
}
