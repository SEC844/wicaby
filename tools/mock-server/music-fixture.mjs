// A small music library for the mocks (Android TV music stopgap): 3 artists, 4 albums, 12 tracks and an audio
// playlist, under a "Musique" CollectionFolder. Every track streams as generated silence (WAV, 8 kHz mono 16-bit):
// nothing audible ever plays from a test. mock-emby.mjs adds it with MOCK_DATASET=demo or MOCK_MUSIC=1.
const TICKS_S = 10_000_000;

export const MUSIC = [
  { artist: 'Les Ondes Calmes', albums: [{ name: 'Marée basse', year: 2021, tracks: ['Écume', 'Phare', 'Sable mouillé'] }, { name: 'Brume', year: 2023, tracks: ['Aube grise', 'Côte'] }] },
  { artist: 'Night Arcade', albums: [{ name: 'Neon Avenue', year: 2022, tracks: ['Insert Coin', 'High Score', 'Continue?', 'Game Over'] }] },
  { artist: 'Zéphyr Trio', albums: [{ name: 'Trois vents', year: 2020, tracks: ['Mistral', 'Tramontane', 'Sirocco'] }] },
];

// Adds the library through mock-emby's own add() and makeList() (the playlist keeps its entry ids).
export function addMusic({ add, makeList }) {
  add({ Id: 'lib-music', Name: 'Musique', Type: 'CollectionFolder', CollectionType: 'music', IsFolder: true, ImageTags: { Primary: 't' } });
  const all = [];
  MUSIC.forEach((a, ai) => {
    const artistId = `artist-${ai}`;
    const artistItem = { Id: artistId, Name: a.artist };
    add({ Id: artistId, Name: a.artist, Type: 'MusicArtist', IsFolder: true, ImageTags: { Primary: 'p' } });
    a.albums.forEach((al, bi) => {
      const albumId = `album-${ai}-${bi}`;
      add({
        Id: albumId, Name: al.name, Type: 'MusicAlbum', IsFolder: true, ParentId: 'lib-music', ProductionYear: al.year,
        AlbumArtist: a.artist, AlbumArtists: [artistItem], ArtistItems: [artistItem], Artists: [a.artist], ImageTags: { Primary: 'p' }, ChildCount: al.tracks.length,
      });
      al.tracks.forEach((t, ti) => {
        const id = `track-${ai}-${bi}-${ti}`;
        all.push(id);
        add({
          Id: id, Name: t, Type: 'Audio', MediaType: 'Audio', ParentId: albumId, IndexNumber: ti + 1, ParentIndexNumber: 1,
          Album: al.name, AlbumId: albumId, AlbumPrimaryImageTag: 'p', AlbumArtist: a.artist, AlbumArtists: [artistItem], ArtistItems: [artistItem], Artists: [a.artist],
          RunTimeTicks: (20 + ti * 5) * TICKS_S, ProductionYear: al.year, Container: 'wav',
        });
      });
    });
  });
  makeList('playlist-music', 'Mix du dimanche', 'Playlist', [all[0], all[5], all[9], all[2]]);
  return all;
}

export const isMusic = (item) => item?.Type === 'Audio';

// What PlaybackInfo answers for a track: one direct-play WAV source with its audio stream.
export function musicSource(item) {
  return {
    Id: item.Id, Name: item.Name, Protocol: 'File', Container: 'wav', Path: `/music/${item.Id}.wav`, Size: wavBytes(item.RunTimeTicks / TICKS_S),
    Bitrate: 128_000, RunTimeTicks: item.RunTimeTicks, SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: true, DefaultAudioStreamIndex: 0,
    MediaStreams: [{ Type: 'Audio', Index: 0, Codec: 'pcm_s16le', Channels: 1, SampleRate: 8000, IsDefault: true, Language: 'und', DisplayTitle: 'PCM mono' }],
  };
}

const RATE = 8000;
const wavBytes = (seconds) => 44 + Math.round(seconds * RATE) * 2;

// [seconds] of silence as a WAV file.
export function silentWav(seconds) {
  const data = Math.round(seconds * RATE) * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  return b; // the samples stay zero: silence
}
