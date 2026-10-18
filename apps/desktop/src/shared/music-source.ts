// "Source de la musique" (Settings > Music): the server whose music and playlists libraries the Music section shows.
// '' (Auto) keeps every server's. A source that is offline, removed or without a music library changes nothing, so
// Music never empties. Kotlin twin: android core/music/MusicSource.kt; vectors in fixtures/subsonic/vectors.json.
export function musicViews<T extends { ServerId?: string; CollectionType?: string }>(views: T[], source: string): T[] {
  if (!source || !views.some((v) => v.ServerId === source && v.CollectionType === 'music')) return views;
  return views.filter((v) => v.ServerId === source || (v.CollectionType !== 'music' && v.CollectionType !== 'playlists'));
}

// The servers the picker offers: those with a music library, once each, in library order.
export function musicSources<T extends { ServerId?: string; CollectionType?: string }>(views: T[]): string[] {
  return [...new Set(views.filter((v) => v.CollectionType === 'music' && v.ServerId).map((v) => v.ServerId!))];
}
