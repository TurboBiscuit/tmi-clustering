import cluster from 'cluster'
import os from "os";
import tmi from "tmi.js"
const numCPUs = os.cpus().length;
if (cluster.isMaster) {
    var channels = []
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }
    cluster.on('exit', (worker, code, signal) => {
        cluster.fork();
    });
    cluster.on('online', (worker) => {
        worker.tmi = {
            ready: false,
            server: null,
            port: null,
            channels: [],
            latency: 0
        }
    })
    function refresh() {
        //var workers = Object.values(cluster.workers)
        //console.log(`=======================================\n${workers.map(worker=>{
        //    return `[#${worker.id}] ${worker.tmi?`${worker.tmi.ready?'Ready':'Not Ready'}${worker.tmi.ready?` (${(worker.tmi.latency*1000).toFixed(2)}ms)`:''} (${worker.tmi.channels.length} Channels)`:''}`
        //}).join('\n')}\n===============${workers.map(worker=>worker.tmi?worker.tmi.channels.length:0).reduce((a,b)=>a+b)}/${channels.length}=================`)
    }
    cluster.on('message', (worker, message) => {
        switch (message.event) {
            case 'READY':
                cluster.workers[message.id].tmi.ready = true
                cluster.workers[message.id].tmi.server = message.server
                cluster.workers[message.id].tmi.port = message.port
                refresh()
                var ready = Object.values(cluster.workers).filter(e => e.tmi.ready).length
                var total = Object.keys(cluster.workers).length
                if (ready == total) {
                    allReady()
                }
                break;
            case 'UNREADY':
                cluster.workers[message.id].tmi.ready = false
                cluster.workers[message.id].tmi.server = null
                cluster.workers[message.id].tmi.port = null
                refresh()
                break;
            case 'JOIN':
                if (Object.values(cluster.workers).find(e => e.tmi.channels.includes(message.channel))) return cluster.workers[message.id].send({ event: 'LEAVE', channel: message.channel })
                if (!cluster.workers[message.id].tmi.channels.includes(message.channel)) cluster.workers[message.id].tmi.channels.push(message.channel)
                refresh()
                break;
            case 'LEAVE':
                var channels_ = Array(cluster.workers[message.id].tmi.channels)
                var index = channels_.indexOf(message.channel)
                if (index != -1) channels_.splice(index, 1)
                refresh()
                break;
            case 'PING':
                cluster.workers[message.id].tmi.latency = message.latency
                refresh()
                break;
        }
    })
    function allReady() {
        channels.forEach(join)
    }
    function join(channel) {
        var workers = Object.values(cluster.workers)
        var ready = workers.filter(e => e.tmi.ready)
        if (ready.length == 0) return
        var worker = ready[ready.sort((a, b) => a.tmi.channels.length - b.tmi.channels.length).map((e, i) => i)[0]]
        if (!worker.tmi.channels.includes(channel)) worker.tmi.channels.push(channel)
        worker.send({ event: 'JOIN', channel })
    }
    function leave(channel) {
        var workers = Object.values(cluster.workers)
        var worker = workers.find(e => e.tmi.channels.includes(channel))
        if (!worker) return
        var channels = worker.tmi.channels
        var index = channels.indexOf(channel)
        if (index != -1) channels.splice(index, 1)
        worker.send({ event: 'LEAVE', channel })
    }
} else {
    var channels = new Map()
    const client = new tmi.Client({
        connection: {
            secure: true,
            reconnect: true
        }
    });
    client.setMaxListeners(999999)
    client.connected = false
    client.connect();
    client.on('reconnect', () => {
        channels.forEach(channel => client.join(channel))
    })
    client.on('disconnect', (reason) => {
        client.connected = false
        process.send({ event: 'UNREADY', id: cluster.worker.id })
    })
    client.on('connected', async (server, port) => {
        client.connected = true
        process.send({ event: 'READY', id: cluster.worker.id, server, port })
    })
    if (client.connected) process.send({ event: 'PING', id: cluster.worker.id, latency: await client.ping() })
    setInterval(async () => {
        if (client.connected) process.send({ event: 'PING', id: cluster.worker.id, latency: await client.ping() })
    }, 3000)
    client.on('join', (channel) => {
        channel = channel.slice(1)
        if (!channels.has(channel)) return client.part(channel)
        process.send({ event: 'JOIN', id: cluster.worker.id, channel })
    })
    client.on('part', (channel) => {
        channel = channel.slice(1)
        if (channels.has(channel)) return client.join(channel)
        process.send({ event: 'LEAVE', id: cluster.worker.id, channel })
    })
    client.on('message', (channel, tags, message, self) => {
        console.log(`[${cluster.worker.id}] [#${channel.slice(1)}] ${tags['display-name']}: ${message}`);
    });
    process.on('message', (message) => {
        switch (message.event) {
            case 'JOIN':
                channels.set(message.channel)
                if (client.connected) client.join(message.channel)
                break;
            case 'LEAVE':
                channels.delete(message.channel)
                if (client.connected) client.part(message.channel)
                break;
        }
    })
    process.on('unhandledRejection', (reason) => {

    })
}