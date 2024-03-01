# Simple Peer

[![npm version](https://badge.fury.io/js/@ffgflash%2Fsimple-peer.svg)](https://badge.fury.io/js/@ffgflash%2Fsimple-peer)
![NPM Downloads](https://img.shields.io/npm/dt/%40ffgflash%2Fsimple-peer)

- [Simple Peer](#simple-peer)
  - [The Goal](#the-goal)
  - [Documentation](#documentation)
  - [Examples](#examples)
    - [Signaling](#signaling)
    - [Streaming Video](#streaming-video)
    - [Sending Data](#sending-data)
    - [Putting It All Together](#putting-it-all-together)

## The Goal

The goal of this library is to make writing p2p code a breeze. Simply create your peers, use the signaling server of your choice and get to making live video calls and more!

## Documentation

For documentation click [here](https://ffgflash.github.io/SimplePeer/).

## Examples

### Signaling

Using event based signaling makes it incredibly easy to hook into any method of signaling whether that be using websockets, api calls, etc.

In the example below we use the BroadcastChannel API to signal between two browser tabs.

```ts
const peer = new SimplePeer()

const channel = new BroadcastChannel('example-signal-server')
peer.on('signal', signal => channel.postMessage(JSON.stringify(signal)))
channel.addEventListener('message', ({ data }) =>
  peer.handleSignal(JSON.parse(data))
)

function start() {
  peer.open()
}

function stop() {
  peer.close()
}
```

### Streaming Video

Creating and managing streams is super simple with simple peer, simply listen for when a stream is added/removed.

See [Signaling Example](#signaling) for how to establish a p2p connection.

```ts
const peer = new SimplePeer()

const video = document.getElementById<HTMLVideoElement>('#video')

let remoteVideo: MediaStream | null = null
let localVideo: MediaStream | null = null

peer.on('add-stream', (name, stream) => {
  if (name === 'video') remoteVideo = video.srcObject = stream
})

peer.on('remove-stream', id => {
  if (remoteVideo.id === id) {
    video.pause()
    remoteVideo = video.srcObject = null
    video.removeAttribute('src')
    video.load()
  }
})

async function startVideo() {
  try {
    localVideo = await navigator.getUserMedia({ video: true, audio: true })
    peer.addStream('video', localVideo)
  } catch {}
}

function stopVideo() {
  peer.removeStream(localVideo)
  localVideo.getTracks().forEach(track => {
    track.stop()
    localVideo!.removeTrack(track)
  })
  localVideo = null
}
```

### Sending Data

Sending data using data channels is again simplified

See [Signaling Example](#signaling) for how to establish a p2p connection.

```ts
const peer = new SimplePeer()
const sender = crypto.randomUUID()

let messageChannel: RTCDataChannel | null = null

function setupMessageChannel(channel) {
  messageChannel?.close()
  messageChannel = channel
  channel.addEventListener('message', ({ data }) =>
    handleMessage(JSON.parse(data))
  )
}

function handleMessage(message) {
  console.log(`${message.sender}: ${message.content}`)
}

function sendMessage(content) {
  messageChannel.send(JSON.stringify({ sender, content }))
}

peer.on('data-channel', channel => {
  switch (channel.label) {
    case 'message-channel':
      setupMessageChannel(channel)
      break
    default:
      break
  }
})

function start() {
  peer.createDataChannel('message-channel')
  peer.open()
}
```

### Putting It All Together

Click [here](https://codepen.io/FFGFlash/pen/ExMzZVG) for an interactive example where we put everything into practice.

Open the example in two tabs and press connect to try everything out.
