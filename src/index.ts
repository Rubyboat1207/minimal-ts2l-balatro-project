import * as ge from './game_events'

Object.keys(ge).forEach(key => {
    globalThis[key] = ge[key];
})

globalThis.print('Module loaded!');