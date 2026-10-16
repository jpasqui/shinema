import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  defaultTheme,
  midnightTheme,
  archiveTheme,
  importTheme,
  exportTheme,
  parseTheme,
  themeCssVariables,
  MAX_THEME_BYTES,
} from '../../../packages/design-tokens/theme.ts';
import type {
  Theme,
  ThemeColors,
  ThemeDesign,
} from '../../../packages/design-tokens/theme.ts';
import {
  appearanceKey,
  defaultAppearance,
  parseAppearance,
  recoverAppearance,
} from './appearance.ts';
import type { Appearance } from './appearance.ts';

type AppearanceContext = { preferences: Appearance; open: () => void };
const Context = createContext<AppearanceContext | null>(null);
export function useAppearance() {
  const context = useContext(Context);
  if (!context) throw new Error('AppearanceProvider is required.');
  return context.preferences;
}
const labels: Record<keyof ThemeColors, string> = {
  background: 'Background',
  surface: 'Surface',
  elevated: 'Elevated',
  text: 'Text',
  muted: 'Muted',
  accent: 'Accent',
  onAccent: 'On accent',
  focus: 'Focus',
  danger: 'Danger',
};

export function AppearanceButton({ disabled = false }: { disabled?: boolean }) {
  const context = useContext(Context);
  return (
    <button
      className="appearance-button"
      aria-label="Appearance"
      title="Appearance"
      onClick={context?.open}
      disabled={disabled}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="8" />
        <path d="M12 4a8 8 0 0 0 0 16Z" fill="currentColor" stroke="none" />
      </svg>
      <span>Appearance</span>
    </button>
  );
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(() => {
    try {
      return recoverAppearance(localStorage.getItem(appearanceKey));
    } catch {
      return {
        value: defaultAppearance(),
        error:
          'Appearance storage is unavailable. Changes will last for this session.',
      };
    }
  });
  const [preferences, setPreferences] = useState(initial.value);
  const [notice, setNotice] = useState(initial.error);
  const [open, setOpen] = useState(false);
  const [systemReduced, setSystemReduced] = useState(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const trigger = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (wasOpen.current && !open)
      trigger.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);
  const reduced =
    systemReduced ||
    preferences.motion === 'reduced' ||
    preferences.theme.design.motion === 'still';
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setSystemReduced(query.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  useLayoutEffect(() => {
    const element = document.documentElement;
    for (const [name, value] of Object.entries(
      themeCssVariables(preferences.theme),
    ))
      element.style.setProperty(name, value);
    element.dataset.motion = reduced ? 'reduced' : 'full';
    element.dataset.theme = preferences.theme.name;
    element.dataset.skin = preferences.theme.design.skin;
    element.dataset.density = preferences.theme.design.density;
    element.dataset.cards = preferences.theme.design.cards;
    element.dataset.typography = preferences.theme.design.typography;
  }, [preferences.theme, reduced]);
  const apply = (next: Appearance) => {
    const validated = parseAppearance(next);
    setPreferences(validated);
    try {
      localStorage.setItem(appearanceKey, JSON.stringify(validated));
      setNotice('Appearance saved on this browser.');
    } catch {
      setNotice(
        'Appearance applied for this session. Browser storage is unavailable.',
      );
    }
  };
  const close = () => setOpen(false);
  return (
    <Context.Provider
      value={{
        preferences,
        open: () => {
          trigger.current = document.activeElement as HTMLElement;
          setOpen(true);
        },
      }}
    >
      {children}
      {!open && initial.error && (
        <p className="appearance-storage-notice" role="status">
          {notice}
        </p>
      )}
      {open && (
        <AppearancePanel
          preferences={preferences}
          notice={notice}
          apply={apply}
          close={close}
        />
      )}
    </Context.Provider>
  );
}

function AppearancePanel({
  preferences,
  notice,
  apply,
  close,
}: {
  preferences: Appearance;
  notice: string;
  apply: (next: Appearance) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [draft, setDraft] = useState<Theme>(preferences.theme);
  const [json, setJson] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    const scroll = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      element.close();
      document.body.style.overflow = scroll;
    };
  }, []);
  const useTheme = (theme: Theme) => {
    setDraft(theme);
    setError('');
    apply({ ...preferences, theme });
  };
  const applyDraft = () => {
    try {
      useTheme(parseTheme(draft));
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'This theme is invalid.',
      );
    }
  };
  const importJson = () => {
    try {
      useTheme(importTheme(json));
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'This theme is invalid.',
      );
    }
  };
  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_THEME_BYTES) {
      setError('Theme files must be 8 KiB or smaller.');
      return;
    }
    try {
      const text = await file.text();
      const theme = importTheme(text);
      setJson(exportTheme(theme));
      setError('');
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Could not read this theme file.',
      );
    }
  };
  const download = () => {
    const value = exportTheme(preferences.theme);
    setJson(value);
    const url = URL.createObjectURL(
      new Blob([value], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'shinema-theme.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const key = (event: KeyboardEvent<HTMLDialogElement>) => {
    event.stopPropagation();
    const elements = [
      ...dialog.current!.querySelectorAll<HTMLElement>(
        'button,input,select,textarea,summary,a[href]',
      ),
    ].filter(
      (element) =>
        element.getClientRects().length && !element.hasAttribute('disabled'),
    );
    const active = document.activeElement as HTMLElement;
    if (event.key === 'Tab') {
      if (event.shiftKey && active === elements[0]) {
        event.preventDefault();
        elements.at(-1)?.focus();
      } else if (!event.shiftKey && active === elements.at(-1)) {
        event.preventDefault();
        elements[0]?.focus();
      }
      return;
    }
    if (
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    )
      return;
    const origin = active.getBoundingClientRect();
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    if (active instanceof HTMLSelectElement && horizontal) return;
    if (
      active instanceof HTMLInputElement &&
      active.type !== 'color' &&
      horizontal
    )
      return;
    if (
      active instanceof HTMLTextAreaElement &&
      (horizontal ||
        (event.key === 'ArrowUp'
          ? active.selectionStart > 0
          : active.selectionEnd < active.value.length))
    )
      return;
    const positive = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const candidate = elements
      .filter((element) => element !== active)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const dx = rect.x + rect.width / 2 - origin.x - origin.width / 2;
        const dy = rect.y + rect.height / 2 - origin.y - origin.height / 2;
        const distance = horizontal ? dx : dy;
        return {
          element,
          distance,
          score: Math.abs(distance) + Math.abs(horizontal ? dy : dx) * 2.5,
        };
      })
      .filter((item) => (positive ? item.distance > 10 : item.distance < -10))
      .sort((a, b) => a.score - b.score)[0];
    event.preventDefault();
    candidate?.element.focus({ preventScroll: true });
    candidate?.element.scrollIntoView({
      block: 'nearest',
      behavior: 'instant',
    });
  };
  return (
    <dialog
      className="appearance-dialog"
      ref={dialog}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={key}
    >
      <div className="appearance-heading">
        <div>
          <p className="eyebrow">MAKE IT YOUR PICTURE HOUSE</p>
          <h2 id={headingId}>Appearance</h2>
        </div>
        <button
          className="dialog-close"
          aria-label="Close appearance"
          onClick={close}
        >
          ×
        </button>
      </div>
      <p className="appearance-intro">
        Choose a skin, then make it yours. Layout, typography, spacing, cards
        and colours share the same collection and playback.
      </p>
      <section aria-label="Theme presets" className="theme-presets">
        {[defaultTheme, archiveTheme, midnightTheme].map((theme) => (
          <button
            key={theme.name}
            aria-pressed={
              preferences.theme.name === theme.name &&
              JSON.stringify(preferences.theme.colors) ===
                JSON.stringify(theme.colors) &&
              JSON.stringify(preferences.theme.design) ===
                JSON.stringify(theme.design)
            }
            onClick={() => useTheme(theme)}
            style={{
              background: theme.colors.background,
              color: theme.colors.text,
              borderColor: theme.colors.focus,
            }}
          >
            <span className="preset-colours">
              <i style={{ background: theme.colors.accent }} />
              <i style={{ background: theme.colors.text }} />
              <i style={{ background: theme.colors.surface }} />
            </span>
            {theme.name}
          </button>
        ))}
      </section>
      <section className="skin-settings" aria-label="Design settings">
        <div className="section-heading">
          <h3>Design, not just colour</h3>
        </div>
        <p>
          Marquee and Archive use different compositions with the same
          collection and playback. Design settings use trusted, built-in
          choices. Use arrows to move between settings; press Enter to choose a
          value.
        </p>
        {(
          Object.entries({
            skin: ['marquee', 'archive'],
            typography: ['cinema', 'editorial', 'system'],
            density: ['comfortable', 'compact'],
            cards: ['poster', 'landscape'],
            motion: ['subtle', 'still'],
          }) as [keyof ThemeDesign, string[]][]
        ).map(([name, values]) => (
          <label key={name}>
            <span>
              {
                {
                  skin: 'Skin layout',
                  typography: 'Typography',
                  density: 'Spacing',
                  cards: 'Card design',
                  motion: 'Skin motion',
                }[name]
              }
            </span>
            <select
              aria-label={
                {
                  skin: 'Skin layout',
                  typography: 'Typography',
                  density: 'Spacing',
                  cards: 'Card design',
                  motion: 'Skin motion',
                }[name]
              }
              value={preferences.theme.design[name]}
              onChange={(event) => {
                const theme = parseTheme({
                  ...preferences.theme,
                  design: {
                    ...preferences.theme.design,
                    [name]: event.target.value,
                  },
                });
                useTheme(theme);
              }}
            >
              {values.map((value) => (
                <option key={value} value={value}>
                  {value[0].toUpperCase() + value.slice(1)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </section>
      <div className="motion-row">
        <label htmlFor="appearance-motion">Motion</label>
        <select
          id="appearance-motion"
          value={preferences.motion}
          onChange={(event) =>
            apply({
              ...preferences,
              motion: event.target.value as Appearance['motion'],
            })
          }
        >
          <option value="system">Follow system</option>
          <option value="reduced">Reduce motion</option>
        </select>
        <p>System reduced motion is always respected.</p>
      </div>
      <section className="palette-editor" aria-label="Custom palette">
        <div className="section-heading">
          <h3>Custom palette</h3>
          <span>Solid colours · contrast checked</span>
        </div>
        <label className="theme-name">
          Theme name
          <input
            value={draft.name}
            maxLength={48}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
        </label>
        <div className="palette-colours">
          {Object.entries(labels).map(([key, label]) => (
            <label key={key}>
              <span>{label}</span>
              <input
                type="color"
                aria-label={label}
                value={draft.colors[key as keyof ThemeColors]}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    colors: { ...draft.colors, [key]: event.target.value },
                  })
                }
              />
              <small>{draft.colors[key as keyof ThemeColors]}</small>
            </label>
          ))}
        </div>
        <button className="primary" onClick={applyDraft}>
          Apply palette
        </button>
      </section>
      <details className="theme-transfer">
        <summary>Import or export a theme</summary>
        <p>
          Version 1 JSON only, up to 8 KiB. Unsupported fields, code, URLs and
          unreadable colour combinations are rejected.
        </p>
        <label className="file-import">
          Choose theme JSON
          <input
            type="file"
            accept=".json,application/json"
            onChange={(event) => {
              void loadFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </label>
        <label className="json-label">
          Theme JSON
          <textarea
            value={json}
            maxLength={MAX_THEME_BYTES + 1}
            spellCheck={false}
            onChange={(event) => setJson(event.target.value)}
          />
        </label>
        <div className="theme-transfer-actions">
          <button className="control-button" onClick={importJson}>
            Apply theme JSON
          </button>
          <button className="control-button" onClick={download}>
            Export theme
          </button>
        </div>
      </details>
      {error && (
        <p className="theme-error" role="alert">
          {error} Your current appearance has not changed.
        </p>
      )}
      {notice && (
        <p className="theme-notice" role="status">
          {notice}
        </p>
      )}
      <div className="appearance-footer">
        <button
          className="text-button"
          onClick={() => {
            setDraft(defaultTheme);
            setJson('');
            setError('');
            apply(defaultAppearance());
          }}
        >
          Reset appearance
        </button>
        <button className="primary" onClick={close}>
          Done
        </button>
      </div>
    </dialog>
  );
}
