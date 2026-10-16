import { useEffect, useRef, useState } from 'react';
import {
  defaultLibraries,
  contentTypeForLibrary,
  emptyNavigationPreferences,
  parseLibraries,
  parseNavigationPreferences,
} from '../../../packages/contracts/index.ts';
import type {
  Libraries,
  LibraryDescriptor,
  NavigationPreferences,
} from '../../../packages/contracts/index.ts';
const descriptorKey = 'shinema.web.libraries.v1';
const preferencesKey = 'shinema.web.navigation.v1';
/** Existing video browse adapter; content type identity is kept in descriptors. */
export function libraryBrowseCollection(
  library: LibraryDescriptor,
): 'movies' | 'tv' | 'all' {
  const id = contentTypeForLibrary(library);
  return id === 'movies' || id === 'tv' ? id : 'all';
}
function readLibraries(): Libraries {
  try {
    return parseLibraries(
      JSON.parse(localStorage.getItem(descriptorKey) ?? 'null'),
    );
  } catch {
    return defaultLibraries();
  }
}
function readPreferences(): NavigationPreferences {
  try {
    return parseNavigationPreferences(
      JSON.parse(localStorage.getItem(preferencesKey) ?? 'null'),
    );
  } catch {
    return emptyNavigationPreferences();
  }
}
export function useLibraries() {
  const [document, setDocument] = useState(readLibraries);
  const [preferences, setPreferences] = useState(readPreferences);
  const [status, setStatus] = useState('Loading libraries…');
  const [legacy, setLegacy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const confirmedRevision = useRef(document.revision);
  useEffect(() => {
    const refresh = () => setRefresh((value) => value + 1);
    window.addEventListener('online', refresh);
    window.addEventListener('shinema:libraries-refresh', refresh);
    return () => {
      window.removeEventListener('online', refresh);
      window.removeEventListener('shinema:libraries-refresh', refresh);
    };
  }, []);
  useEffect(() => {
    const ticket = ++generation.current;
    const controller = new AbortController();
    void fetch('/api/libraries', { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) {
          if (confirmedRevision.current > 0)
            throw new Error('Library configuration is unavailable');
          if (ticket !== generation.current) return;
          setDocument(defaultLibraries());
          setLegacy(true);
          setStatus('Using default libraries on an older server.');
          return;
        }
        if (!response.ok) throw new Error('Library request failed');
        const next = parseLibraries(await response.json());
        if (next.revision < confirmedRevision.current)
          throw new Error('Stale library configuration');
        if (ticket !== generation.current) return;
        setDocument(next);
        confirmedRevision.current = next.revision;
        setLegacy(false);
        setStatus('');
        try {
          localStorage.setItem(descriptorKey, JSON.stringify(next));
        } catch {
          setStatus(
            'Library settings are available for this session; browser storage is unavailable.',
          );
        }
      })
      .catch(() => {
        if (ticket === generation.current)
          setStatus('Server unavailable. Saved library navigation is shown.');
      });
    return () => {
      ++generation.current;
      controller.abort();
    };
  }, [refresh]);
  const savePreferences = (value: NavigationPreferences) => {
    const next = parseNavigationPreferences(value);
    setPreferences(next);
    try {
      localStorage.setItem(preferencesKey, JSON.stringify(next));
    } catch {
      setStatus('Navigation preferences could not be saved in this browser.');
    }
  };
  return {
    document,
    preferences,
    savePreferences,
    status,
    legacy,
    reload: () => setRefresh((value) => value + 1),
  };
}
