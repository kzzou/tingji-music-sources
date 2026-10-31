const { test } = require('node:test')
const assert = require('node:assert/strict')
const { wyFixture, mgFixture } = require('../scripts/refresh-fixtures.cjs')
test('WY verifies the returned ID before using first-party metadata', () => {
  assert.throws(() => wyFixture({ code: 200, songs: [{ id: 123, name: 'wrong', artists: [{ name: 'artist' }] }] }))
  const result = wyFixture({ code: 200, songs: [{ id: 186016, name: 'Reference song', artists: [{ name: 'Artist' }], album: { id: 1, name: 'Album' }, duration: 269000 }] })
  assert.equal(result.modern.id, 'wy_186016')
  assert.equal(result.modern.meta.songId, 186016)
  assert.equal(result.modern.interval, '04:29')
})
test('MG requires both real IDs and the requested artist/title', () => {
  assert.throws(() => mgFixture({ code: '000000', songResultData: { resultList: [[{ songId: 1, name: '稻香', singerList: [{ name: '周杰伦' }] }]] } }))
  const result = mgFixture({ code: '000000', songResultData: { resultList: [[{ songId: 'real-song', copyrightId: 'real-copyright', name: '稻香', singerList: [{ name: '周杰伦' }], duration: 223 }]] } })
  assert.equal(result.modern.meta.copyrightId, 'real-copyright')
  assert.equal(result.legacy.songmid, 'real-song')
  assert.equal(result.modern.id, 'mg_real-song')
})
test('requested 知我 reference ID cannot substitute a different artist or song', () => {
  const body = { code: 200, songs: [{ id: 1394167216, name: '知我', artists: [{ name: '国风堂' }, { name: '哦漏' }], duration: 292000 }] }
  assert.equal(wyFixture(body, '1394167216', true).modern.id, 'wy_1394167216')
  body.songs[0].artists = [{ name: 'Another cover singer' }]
  assert.throws(() => wyFixture(body, '1394167216', true), /mismatch/)
})
