// Self-check for HDR detection (src/shared/hdr.ts, src/main/playback/hdr.ts): server stream fields
// (Jellyfin and Emby), mpv video-params, labels and the Windows HDR helper reply.
// Run: node tools/checks/hdr-check.mjs
import assert from 'node:assert/strict';
import { dvNeedsReshaping, hdrFromMpv, hdrLabel, hdrOutputShown, markerDevices, mergeHdr, parseHdrReply } from '../../apps/desktop/src/main/playback/hdr.ts';
import { dvFallback, hdrChip, hdrFromStream } from '../../apps/desktop/src/shared/hdr.ts';

const v = (fields) => ({ Index: 0, Type: 'Video', ...fields });

// Jellyfin
assert.deepEqual(hdrFromStream(v({ VideoRange: 'HDR', VideoRangeType: 'DOVI', DvProfile: 5, DvBlSignalCompatibilityId: 0 })), { kind: 'dv', dvProfile: '5' });
assert.deepEqual(hdrFromStream(v({ VideoRangeType: 'DOVIWithHDR10', DvProfile: 8, DvBlSignalCompatibilityId: 1 })), { kind: 'dv', dvProfile: '8.1' });
assert.deepEqual(hdrFromStream(v({ VideoRangeType: 'DOVIWithEL', DvProfile: 7, DvBlSignalCompatibilityId: 6 })), { kind: 'dv', dvProfile: '7.6' });
assert.deepEqual(hdrFromStream(v({ VideoRangeType: 'DOVIInvalid', ColorTransfer: 'arib-std-b67' })), { kind: 'hlg' });
assert.deepEqual(hdrFromStream(v({ VideoRangeType: 'HDR10Plus' })), { kind: 'hdr10+' });
assert.deepEqual(hdrFromStream(v({ VideoRangeType: 'HLG' })), { kind: 'hlg' });
assert.deepEqual(hdrFromStream(v({ VideoRange: 'SDR', VideoRangeType: 'SDR' })), { kind: 'sdr' });
// Emby
assert.deepEqual(hdrFromStream(v({ VideoRange: 'HDR', ExtendedVideoType: 'DolbyVision', ExtendedVideoSubType: 'DoviProfile81' })), { kind: 'dv', dvProfile: '8.1' });
assert.deepEqual(hdrFromStream(v({ VideoRange: 'HDR', ExtendedVideoType: 'DolbyVision', ExtendedVideoSubType: 'DoviProfile50' })), { kind: 'dv', dvProfile: '5' });
assert.deepEqual(hdrFromStream(v({ VideoRange: 'HDR', ExtendedVideoType: 'Hdr10Plus' })), { kind: 'hdr10+' });
assert.deepEqual(hdrFromStream(v({ VideoRange: 'HDR', ExtendedVideoType: 'HyperLogGamma' })), { kind: 'hlg' });
assert.deepEqual(hdrFromStream(v({ VideoRange: 'HDR', ExtendedVideoType: 'None', ColorTransfer: 'arib-std-b67' })), { kind: 'hlg' });
assert.deepEqual(hdrFromStream(v({ VideoRange: 'HDR' })), { kind: 'hdr10' });
assert.deepEqual(hdrFromStream(v({ VideoRange: 'SDR', ExtendedVideoType: 'None' })), { kind: 'sdr' });
assert.equal(hdrFromStream(v({})), null);
assert.equal(hdrFromStream(undefined), null);

// Item page chips: brand names, the DV fallback layer when there is one, nothing for SDR.
assert.equal(hdrChip(v({ VideoRangeType: 'DOVIWithHDR10', DvProfile: 8, DvBlSignalCompatibilityId: 1 })), 'Dolby Vision · HDR10');
assert.equal(hdrChip(v({ VideoRangeType: 'DOVIWithHLG', DvProfile: 8, DvBlSignalCompatibilityId: 4 })), 'Dolby Vision · HLG');
assert.equal(hdrChip(v({ VideoRangeType: 'DOVI', DvProfile: 5, DvBlSignalCompatibilityId: 0 })), 'Dolby Vision');
assert.equal(hdrChip(v({ VideoRangeType: 'DOVIWithEL', DvProfile: 7, DvBlSignalCompatibilityId: 6 })), 'Dolby Vision · HDR10');
assert.equal(hdrChip(v({ VideoRange: 'HDR', ExtendedVideoType: 'DolbyVision', ExtendedVideoSubType: 'DoviProfile81' })), 'Dolby Vision · HDR10');
assert.equal(hdrChip(v({ VideoRange: 'HDR', ExtendedVideoType: 'DolbyVision', ExtendedVideoSubType: 'DoviProfile84' })), 'Dolby Vision · HLG');
assert.equal(hdrChip(v({ VideoRange: 'HDR', ExtendedVideoType: 'DolbyVision', ExtendedVideoSubType: 'DoviProfile50' })), 'Dolby Vision');
assert.equal(hdrChip(v({ VideoRange: 'HDR', ExtendedVideoType: 'Hdr10Plus' })), 'HDR10+');
assert.equal(hdrChip(v({ VideoRangeType: 'HDR10Plus' })), 'HDR10+');
assert.equal(hdrChip(v({ VideoRange: 'HDR', ExtendedVideoType: 'Hdr10' })), 'HDR10');
assert.equal(hdrChip(v({ VideoRange: 'HDR', ColorTransfer: 'smpte2084' })), 'HDR10');
assert.equal(hdrChip(v({ VideoRangeType: 'HLG' })), 'HLG');
assert.equal(hdrChip(v({ VideoRange: 'HDR', ExtendedVideoType: 'None', ColorTransfer: 'arib-std-b67' })), 'HLG');
assert.equal(hdrChip(v({ VideoRange: 'SDR', VideoRangeType: 'SDR' })), null);
assert.equal(hdrChip(v({})), null);
assert.equal(dvFallback(v({ VideoRangeType: 'DOVIWithHDR10Plus', DvProfile: 8, DvBlSignalCompatibilityId: 1 })), 'hdr10+');

// mpv video-params, as dumped from the sample clips
assert.deepEqual(hdrFromMpv({ colormatrix: 'dolbyvision', gamma: 'pq' }, 5), { kind: 'dv', dvProfile: '5' });
assert.deepEqual(hdrFromMpv({ colormatrix: 'bt.2020-ncl', gamma: 'pq' }), { kind: 'hdr10' });
assert.deepEqual(hdrFromMpv({ colormatrix: 'bt.2020-ncl', gamma: 'pq', 'scene-max-r': 400 }), { kind: 'hdr10+' });
assert.deepEqual(hdrFromMpv({ colormatrix: 'bt.2020-ncl', gamma: 'hlg' }), { kind: 'hlg' });
assert.deepEqual(hdrFromMpv({ colormatrix: 'bt.709', gamma: 'bt.1886' }), { kind: 'sdr' });
assert.equal(hdrFromMpv(null), null);

// mpv wins on what is rendered; the server adds the DV sub-profile and HDR10+.
assert.deepEqual(mergeHdr({ kind: 'dv', dvProfile: '8.1' }, { kind: 'dv', dvProfile: '8' }), { kind: 'dv', dvProfile: '8.1' });
assert.deepEqual(mergeHdr({ kind: 'hdr10+' }, { kind: 'hdr10' }), { kind: 'hdr10+' });
assert.deepEqual(mergeHdr({ kind: 'dv', dvProfile: '8.1' }, { kind: 'hdr10' }), { kind: 'hdr10' });
assert.deepEqual(mergeHdr(null, { kind: 'hlg' }), { kind: 'hlg' });
assert.deepEqual(mergeHdr({ kind: 'hlg' }, null), { kind: 'hlg' });

assert.equal(hdrLabel({ kind: 'dv', dvProfile: '5' }), 'Dolby Vision P5');
assert.equal(hdrLabel({ kind: 'hdr10' }), 'HDR10');
assert.equal(hdrLabel({ kind: 'hlg' }), 'HLG');
assert.equal(hdrLabel({ kind: 'sdr' }), 'SDR');
assert.equal(hdrLabel(null), undefined);
assert.equal(hdrOutputShown({ kind: 'dv', dvProfile: '5' }, 'sdr'), 'sdr');
assert.equal(hdrOutputShown({ kind: 'hdr10' }, 'passthrough'), 'passthrough');
assert.equal(hdrOutputShown({ kind: 'hlg' }), undefined);
assert.equal(hdrOutputShown({ kind: 'sdr' }, 'hdr'), undefined);
assert.equal(hdrOutputShown(null, 'hdr'), undefined);

assert.equal(dvNeedsReshaping({ kind: 'dv', dvProfile: '5' }), true);
assert.equal(dvNeedsReshaping({ kind: 'dv' }), true);
assert.equal(dvNeedsReshaping({ kind: 'dv', dvProfile: '8.1' }), false);
assert.equal(dvNeedsReshaping({ kind: 'hdr10' }), false);

// Windows HDR helper replies (real output on this machine: "state \\.\DISPLAY1 1 0")
assert.deepEqual(parseHdrReply('state \\\\.\\DISPLAY1 1 0\r\n'), { verb: 'state', device: '\\\\.\\DISPLAY1', supported: true, on: false });
assert.deepEqual(parseHdrReply('set \\\\.\\DISPLAY12 1 1'), { verb: 'set', device: '\\\\.\\DISPLAY12', supported: true, on: true });
assert.equal(parseHdrReply('fail  0 0'), null);
assert.equal(parseHdrReply("keep \\\\.\\DISPLAY1' ; rm 0 0"), null);

// HDR restore token: every display switched, the single-display form older builds wrote, nothing unsafe.
const disp = (n) => String.raw`\\.\DISPLAY` + n;
assert.deepEqual(markerDevices({ devices: [disp(1), disp(2)] }), [disp(1), disp(2)]);
assert.deepEqual(markerDevices({ device: disp(3) }), [disp(3)]);
assert.deepEqual(markerDevices({ devices: [`${disp(1)}' ; rm`, 7, null] }), []);
assert.deepEqual(markerDevices(null), []);
assert.deepEqual(markerDevices('x'), []);

console.log('hdr-check: ok');
