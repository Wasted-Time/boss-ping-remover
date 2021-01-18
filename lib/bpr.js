const fs = require('fs'),
    path = require('path'),
    Ping = require('./ping.js')

module.exports = function BossPingRemover(dispatch, context) {
    // constants
    const ping = Ping(dispatch),
        command = dispatch.command || dispatch.require.command,
        config = require('../config/config.json')

    // variables
    let zone,
        data,
        cache = {},
        currentActions = {},
        writing = false

    // get data
    if (config.version < 6.0) {
        data = {}
        config.version = 6.0
        fs.writeFile(path.join(__dirname, '..', 'config', 'config.json'), JSON.stringify(config, null, '\t'), (err) => {
            if (err) return
            if (config.debug) console.log(`[${Date.now().toString().slice(-4)}] "config.json" updated, "data.json" will be reset on exit`)
        })
    }
    else {
        try {
            data = require('../config/data.json')
        }
        catch (err) {
            data = {}
        }
    }

    // commands
    command.add(['bpr', 'bossPingRemover'], (arg) => {
        if (arg && arg.toLowerCase() == 'debug') {
            config.debug = !config.debug
            command.message(`Boss Ping Remover debug ${config.debug ? 'enabled' : 'disabled'}.`)
        }
        else {
            config.enabled = !config.enabled
            command.message(`Boss Ping Remover ${config.enabled ? 'enabled' : 'disabled'}.`)
            if (!config.enabled) {
                writeCache(cache)
                zone = undefined
                cache = {}
                currentActions = {}
            }
        }
    })
    
    // write cache on disconnect
    context.destructor = () => {
        if (config.enabled) writeCache(cache)
    }
    
    // async write for performance
    function writeCache(cache) {
        clean(cache)
        if (Object.keys(cache).length != 0) {
            Object.assign(data, cache)
            // if being written, don't retry
            if (!writing) {
                writing = true
                fs.writeFile(path.join(__dirname, '..', 'config', 'data.json'), JSON.stringify(data, null, '\t'), (err) => {
                    writing = false
                    if (err) return
                    if (config.debug) console.log(`[${Date.now().toString().slice(-4)}] "data.json" written`)
                })
            }
        }
    }

    // initialize keys and subkeys to avoid "undefined object" errors
    function checkCache(huntingZoneId, templateId) {
        if (config.enabled) {
            // if not cached, try to read from data
            if (!cache[huntingZoneId]) {
                if (data[huntingZoneId]) cache[huntingZoneId] = data[huntingZoneId]
                else cache[huntingZoneId] = {}
            }
            if (!cache[huntingZoneId][templateId]) cache[huntingZoneId][templateId] = {}
        }
    }

    // delete empty objects inside an object
    function clean(obj) {
        for (let key in obj) {
            if (obj[key] && typeof obj[key] === "object") {
                if (Object.keys(obj[key]).length !== 0) {
                    clean(obj[key])
                }
                if (Object.keys(obj[key]).length === 0) {
                    delete obj[key]
                }
            }
        }
    }

    // S_SPAWN_NPC
    dispatch.hook('S_SPAWN_NPC', 12, {order: 200, filter: {fake: null}}, event => {
        if (config.enabled) checkCache(event.huntingZoneId, event.templateId)
    })

    // S_LOAD_TOPO
    dispatch.hook('S_LOAD_TOPO', 3, event => {
        if (config.enabled) {
            if (zone && zone != event.zone) {
                writeCache(cache)
                cache = {}
            }
            zone = event.zone
            currentActions = {}
        }
    })

    // S_ACTION_STAGE
    dispatch.hook('S_ACTION_STAGE', 9, {order: 2000}, event => {
        if (config.enabled && event.skill.npc) {
            let huntingZoneId = event.skill.huntingZoneId,
                templateId = event.templateId,
                skill = event.skill.id
            checkCache(huntingZoneId, templateId)
            // if multi stage, do not update start time
            if (currentActions[event.id] && event.stage > currentActions[event.id].stage) {
                currentActions[event.id] = {
                    time: currentActions[event.id].time,
                    speed: event.speed,
                    stage: event.stage
                }
            }
            else {
                currentActions[event.id] = {
                    time: Date.now(),
                    speed: event.speed,
                    stage: event.stage
                }
            }
            let length = cache[huntingZoneId][templateId][skill]
            if (length > 0 && ping.median) {
                // shorten by ping
                if (config.debug) console.log(`[${Date.now().toString().slice(-4)}] <* sActionStage ${huntingZoneId}-${templateId}-${skill}` 
                    + ` s${event.stage} d${Math.floor(length)} bpr${Math.floor(Math.min(ping.median, length/event.speed-1000/config.minCombatFPS))}`)
                event.speed = event.speed * length / Math.max(length - ping.median * event.speed, 1000/config.minCombatFPS)
                return true
            }
            if (config.debug) console.log(`[${Date.now().toString().slice(-4)}] <- sActionStage ${huntingZoneId}-${templateId}-${skill} s${event.stage} d0 bpr0`)
        }
    })

    // S_ACTION_END
    dispatch.hook('S_ACTION_END', 5, event => {
        if (config.enabled && event.skill.npc) {
            let huntingZoneId = event.skill.huntingZoneId,
                templateId = event.templateId,
                skill = event.skill.id
            if (currentActions[event.id]) {
                let time = (Date.now() - currentActions[event.id].time) / currentActions[event.id].speed
                delete currentActions[event.id]
                if (config.debug) console.log(`[${Date.now().toString().slice(-4)}] <- sActionEnd ${huntingZoneId}-${templateId}-${skill} t${event.type} d${time}`)
                if (event.type == 0) {
                    checkCache(huntingZoneId, templateId)
                    cache[huntingZoneId][templateId][skill] = Math.round(cache[huntingZoneId][templateId][skill] ? (cache[huntingZoneId][templateId][skill] + time) / 2 : time)
                }
            }
        }
    })
}
