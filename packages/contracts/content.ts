import builtinData from './content-registry.json' with { type: 'json' };

export type ContentCapabilities = {
  metadata: boolean;
  play: boolean;
  view: boolean;
  launch: boolean;
};
export type ContentTypeDescriptor = {
  id: string;
  name: string;
  availability: 'available' | 'unavailable';
  capabilities: ContentCapabilities;
  reason?: string;
};
export type FormatDescriptor = ContentTypeDescriptor & {
  extensions: string[];
  mimeTypes: string[];
};
export type ContentRegistry = {
  version: 1;
  contentTypes: ContentTypeDescriptor[];
  formats: FormatDescriptor[];
};
export type ContentSupport = { supported: boolean; reason?: string };

/** IDs describe an open registry, not a closed set of implemented handlers. */
export const validContentId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value);
/** mixed remains a legacy library alias for null, never a content type ID. */
export const validContentTypeId = (value: unknown): value is string =>
  validContentId(value) && value !== 'mixed';
export const validFormatExtension = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(value);
export const validMimeType = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 127 &&
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value === value.trim() &&
  Array.from(value).length <= max &&
  !/[\p{Cc}\p{Cf}]/u.test(value);
const keys = (
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every(
    (key) => required.includes(key) || optional.includes(key),
  );

function parseDescriptor(
  value: unknown,
  format: boolean,
): ContentTypeDescriptor {
  if (
    !record(value) ||
    !keys(
      value,
      [
        'id',
        'name',
        'availability',
        'capabilities',
        ...(format ? ['extensions', 'mimeTypes'] : []),
      ],
      ['reason'],
    ) ||
    !validContentId(value.id) ||
    (!format && value.id === 'mixed') ||
    !text(value.name, 80) ||
    (value.availability !== 'available' &&
      value.availability !== 'unavailable') ||
    (value.reason !== undefined && !text(value.reason, 512)) ||
    !record(value.capabilities) ||
    !keys(value.capabilities, ['metadata', 'play', 'view', 'launch']) ||
    Object.values(value.capabilities).some((flag) => typeof flag !== 'boolean')
  )
    throw new Error('Invalid content registry descriptor');
  return {
    id: value.id,
    name: value.name,
    availability: value.availability,
    capabilities: { ...value.capabilities } as ContentCapabilities,
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
  };
}
function tokens(
  value: unknown,
  valid: (entry: unknown) => entry is string,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    !Array.from(value).every(valid) ||
    new Set(value).size !== value.length
  )
    throw new Error('Invalid content format selectors');
  return [...value] as string[];
}
export function parseContentRegistry(value: unknown): ContentRegistry {
  if (
    !record(value) ||
    !keys(value, ['version', 'contentTypes', 'formats']) ||
    value.version !== 1 ||
    !Array.isArray(value.contentTypes) ||
    value.contentTypes.length > 128 ||
    !Array.isArray(value.formats) ||
    value.formats.length > 128
  )
    throw new Error('Unsupported content registry');
  const contentTypes = Array.from(value.contentTypes, (item) =>
    parseDescriptor(item, false),
  );
  const formats = Array.from(value.formats, (item): FormatDescriptor => {
    const descriptor = parseDescriptor(item, true);
    const raw = item as Record<string, unknown>;
    return {
      ...descriptor,
      extensions: tokens(raw.extensions, validFormatExtension),
      mimeTypes: tokens(raw.mimeTypes, validMimeType),
    };
  });
  if (
    new Set(contentTypes.map((item) => item.id)).size !== contentTypes.length ||
    new Set(formats.map((item) => item.id)).size !== formats.length
  )
    throw new Error('Duplicate content registry identity');
  return { version: 1, contentTypes, formats };
}

// The shipped manifest identifies installed adapters. A server advertisement alone
// cannot install executable behavior in this client.
const installed = parseContentRegistry(builtinData);
const localContentHandlers = new Set(['movies', 'tv']);
export function builtinContentRegistry(): ContentRegistry {
  return parseContentRegistry(installed);
}
export function contentTypeForLibrary(library: {
  contentTypeId?: string | null;
  mediaType?: string;
}): string | null {
  if (library.contentTypeId !== undefined) return library.contentTypeId;
  return library.mediaType === undefined || library.mediaType === 'mixed'
    ? null
    : library.mediaType;
}
function typeSupport(
  id: string | null,
  registry: ContentRegistry,
): ContentSupport {
  // Null selects the installed generic video inventory without metadata grouping.
  if (id === null) return { supported: true };
  if (!validContentTypeId(id))
    return { supported: false, reason: 'Invalid content type identity.' };
  const descriptor = registry.contentTypes.find((item) => item.id === id);
  if (!descriptor)
    return {
      supported: false,
      reason: `The server does not provide content type “${id}”.`,
    };
  if (descriptor.availability !== 'available' || !descriptor.capabilities.play)
    return {
      supported: false,
      reason:
        descriptor.reason ??
        `Content type “${descriptor.name}” is unavailable for playback.`,
    };
  if (
    !localContentHandlers.has(id) ||
    !installed.contentTypes.some(
      (item) =>
        item.id === id &&
        item.availability === 'available' &&
        item.capabilities.play,
    )
  )
    return {
      supported: false,
      reason: `This client has no playback handler for content type “${descriptor.name}”.`,
    };
  return { supported: true };
}
export function libraryContentSupport(
  library: {
    contentTypeId?: string | null;
    mediaType?: string;
  },
  registry: ContentRegistry = installed,
): ContentSupport {
  if (
    library.contentTypeId !== undefined &&
    library.mediaType !== undefined &&
    library.mediaType !== (library.contentTypeId ?? 'mixed')
  )
    return {
      supported: false,
      reason: 'Conflicting library content type identities.',
    };
  return typeSupport(contentTypeForLibrary(library), registry);
}
export function mediaContentSupport(
  media: {
    contentTypeId?: string | null;
    collection?: string;
    formatId?: string;
    container: string;
  },
  registry: ContentRegistry = installed,
): ContentSupport {
  if (
    media.contentTypeId !== undefined &&
    media.collection !== undefined &&
    media.contentTypeId !== media.collection
  )
    return {
      supported: false,
      reason: 'Conflicting media content type identities.',
    };
  const contentTypeId =
    media.contentTypeId !== undefined
      ? media.contentTypeId
      : (media.collection ?? null);
  const content = typeSupport(contentTypeId, registry);
  if (!content.supported) return content;
  // Explicit format identity wins; never turn an unknown format into a known one
  // merely because its extension resembles an installed format.
  const local =
    media.formatId !== undefined
      ? installed.formats.find((format) => format.id === media.formatId)
      : installed.formats.find((format) =>
          format.extensions.includes(media.container),
        );
  if (
    !local ||
    local.availability !== 'available' ||
    !local.capabilities.play ||
    !local.extensions.includes(media.container)
  )
    return {
      supported: false,
      reason: 'This client has no playback handler for this format.',
    };
  const descriptor = registry.formats.find((format) => format.id === local.id);
  if (
    !descriptor ||
    descriptor.availability !== 'available' ||
    !descriptor.capabilities.play ||
    !descriptor.extensions.includes(media.container)
  )
    return {
      supported: false,
      reason:
        descriptor?.reason ??
        'This format is unavailable for playback on the server.',
    };
  return { supported: true };
}
