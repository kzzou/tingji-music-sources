'use strict'
// Public song metadata only. No downloaded source code or user account is used.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { requestPrefix } = require('../lib/network.cjs')
const formatTime = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
const quality = [{ type: '128k', size: null }]
function modern(legacy) {
  const meta = { songId: legacy.songmid, albumName: legacy.albumName, picUrl: legacy.img ?? null, qualitys: legacy.types, _qualitys: legacy._types, albumId: legacy.albumId }
  if (legacy.source === 'mg') meta.copyrightId = legacy.copyrightId
  return { id: `${legacy.source}_${legacy.songmid}`, name: legacy.name, singer: legacy.singer, source: legacy.source, interval: legacy.interval, meta }
}
function wrap(legacy, provider) {
  return { modern: modern(legacy), legacy, provenance: { provider, method: 'Anonymous first-party public song metadata', fetchedAt: new Date().toISOString() } }
}
function wyFixture(body, id = '186016', requested = false) {
  const song = body?.code === 200 && body.songs?.find(item => String(item.id) === id)
  if (!song || !song.name || !Array.isArray(song.artists) || !song.artists.length || !(song.duration > 0)) throw Error('WY did not verify requested song metadata')
  if (requested && (!song.name.includes('知我') || !song.artists.some(artist => /国风堂|哦漏/.test(artist.name)))) throw Error('Requested track title/artist mismatch')
  const fixture = wrap({ source: 'wy', songmid: song.id, name: song.name, singer: song.artists.map(item => item.name).filter(Boolean).join('、'), albumName: song.album?.name || '', albumId: song.album?.id, img: null, interval: formatTime(song.duration / 1000), types: quality, _types: { '128k': { size: null } }, typeUrl: {} }, 'music.163.com')
  if (requested) fixture.requested = true
  return fixture
}
function mgFixture(body) {
  const songs = body?.code === '000000' && Array.isArray(body.songResultData?.resultList) ? body.songResultData.resultList.flat() : []
  const song = songs.find(item => item?.songId && item.copyrightId && item.name?.includes('稻香') && item.singerList?.some(artist => artist.name?.includes('周杰伦')))
  if (!song || !(Number(song.duration) > 0)) throw Error('MG did not verify requested song metadata')
  return wrap({ source: 'mg', songmid: song.songId, copyrightId: song.copyrightId, name: song.name, singer: song.singerList.map(item => item.name).filter(Boolean).join('、'), albumName: song.album || '', albumId: song.albumId, img: null, interval: formatTime(Number(song.duration)), types: quality, _types: { '128k': { size: null } }, typeUrl: {} }, 'jadeite.migu.cn')
}
async function get(url, headers = {}) {
  const response = await requestPrefix(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, signal: AbortSignal.timeout(12000), limit: 262144 })
  if (!response.ok) throw Error(`Public metadata HTTP ${response.statusCode}`)
  return JSON.parse(response.bytes.toString('utf8'))
}
async function refresh() {
  const root = path.resolve(__dirname, '..')
  const output = path.resolve(process.env.TINGJI_FIXTURE_PATH || path.join(root, 'output/fixtures/platforms.json'))
  const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/platforms.json'), 'utf8'))
  const status = {}
  const tasks = {
    wy: async() => {
      const ids = ['1394167216', '186016']
      const results = await Promise.allSettled(ids.map(async(id, index) => wyFixture(await get(`https://music.163.com/api/song/detail/?id=${id}&ids=%5B${id}%5D`), id, index === 0)))
      const rows = results.filter(item => item.status === 'fulfilled').map(item => item.value)
      if (!rows.length) throw Error('No first-party WY song metadata available')
      return rows
    },
    mg: async() => {
      // Signature and public client parameters match the application's existing
      // src/utils/musicSdk/mg/musicSearch.js; this is not a user credential.
      const time = String(Date.now()), query = '稻香 周杰伦', deviceId = '963B7AA0D21511ED807EE5846EC87D20'
      const sign = crypto.createHash('md5').update(`${query}6cdc72a439cef99a3418d2a78aa28c73yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`).digest('hex')
      const url = new URL('https://jadeite.migu.cn/music_search/v3/search/searchAll')
      const searchSwitch = JSON.stringify({ song: 1, album: 0, singer: 0, tagSong: 1, mvSong: 0, bestShow: 1, songlist: 0, lyricSong: 0 })
      url.search = new URLSearchParams({ isCorrect: '0', isCopyright: '1', searchSwitch, pageSize: '3', text: query, pageNo: '1', sort: '0', sid: 'USS' })
      return mgFixture(await get(url, { uiVersion: 'A_music_3.6.1', deviceId, timestamp: time, sign, channel: '0146921' }))
    },
  }
  await Promise.all(Object.entries(tasks).map(async([platform, task]) => {
    try { fixtures[platform] = await task(); status[platform] = 'metadata-verified' }
    catch (error) { status[platform] = `unavailable: ${String(error.message).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 150)}` }
  }))
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(fixtures, null, 2) + '\n')
  fs.writeFileSync(path.join(path.dirname(path.dirname(output)), 'fixture-status.json'), JSON.stringify({ platforms: Object.keys(fixtures), status }, null, 2) + '\n')
  console.log(`Public fixtures: ${Object.keys(fixtures).join(', ')}; unavailable metadata is never invented.`)
}
if (require.main === module) refresh().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { modern, wyFixture, mgFixture, refresh }
