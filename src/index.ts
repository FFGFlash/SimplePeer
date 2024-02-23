import debug from 'debug'
import EventEmitter from 'eventemitter3'
import { v4 } from 'uuid'

const logSignaling = debug('simple-peer:signaling')
const logEvents = debug('simple-peer:events')
const logStreaming = debug('simple-peer:streaming')
const logChannels = debug('simple-peer:channels')

function dequeue<T>(
  array: T[],
  callbackfn: (value: T, index: number, array: T[]) => void,
  thisArg?: any
) {
  array.splice(0, array.length).forEach(callbackfn, thisArg)
}

export default class SimplePeer extends EventEmitter<PeerEvents> {
  #pc!: RTCPeerConnection
  #options: RTCConfiguration
  #negotiated: boolean = false
  #sc!: RTCDataChannel
  #candidates: RTCIceCandidateInit[] = []
  #streams: Record<string, { name?: string; stream?: MediaStream }> = {}
  #streamQueue: { name: string; stream: MediaStream }[] = []
  #channelQueue: string[] = []
  #id!: string
  #polite = false
  #ignoringOffer = false
  #makingOffer = false
  #isSettingRemoteAnswerPending = false
  static #idGenerator: (peer: SimplePeer) => string = () => v4()

  constructor(options: RTCConfiguration = {}) {
    super()
    this.#options = options
  }

  createDataChannel(label: string) {
    if (!this.isOpen) {
      logChannels('>> %s enqueued', label)
      this.#channelQueue.push(label)
      return
    }
    return this.#createDataChannel(label)
  }

  #createDataChannel(label: string) {
    logChannels('** %s created', label)
    this.handleDataChannel(this.#pc.createDataChannel(label))
  }

  get id() {
    return this.#id
  }

  static setIDGenerator(generator: (peer: SimplePeer) => string) {
    this.#idGenerator = generator
  }

  open() {
    if (this.isOpen) return
    this.#id = SimplePeer.#idGenerator(this)
    this.createConnection()
    this.emit('connection-state-change', this.#pc.connectionState)
    this.emit('signaling-state-change', this.#pc.signalingState)
    this.handleDataChannel(this.#pc.createDataChannel('simple-signaling'))
    this.emit('channel-state-change', this.#sc.readyState)
    setTimeout(() => {
      if (this.#negotiated) return
      this.handleNegotiation()
    })
  }

  close() {
    if (!this.isOpen) return
    this.sendSignal({ type: 'close' })
    this.handleClose()
  }

  private handleClose() {
    this.#pc.close()
    this.emit('connection-state-change', this.#pc.connectionState)
    this.emit('signaling-state-change', this.#pc.signalingState)
    this.#negotiated = false
    this.#channelQueue = []
    this.#candidates = []
    this.#streamQueue = []
    this.#streams = {}
    this.#ignoringOffer = false
    this.#makingOffer = false
    this.#isSettingRemoteAnswerPending = false
  }

  addStream(name: string, stream: MediaStream) {
    if (!this.stable) {
      logStreaming('>> %s (%s) enqueued', name, stream.id)
      this.#streamQueue.push({ name, stream })
      return
    }
    return this.#addStream(name, stream)
  }

  #addStream(name: string, stream: MediaStream) {
    logStreaming('>> Added %s (%s)', name, stream.id)
    this.handleAddStream(stream, true)
    this.sendSignal({ type: 'stream', id: stream.id, name })
  }

  removeStream(stream: MediaStream) {
    if (!this.isOpen) return
    this.handleRemoveStream(stream, true)
  }

  private handleAddStream(newStream: MediaStream, local = false) {
    if (local)
      return newStream
        .getTracks()
        .forEach(track => this.#pc.addTrack(track, newStream))
    newStream.onremovetrack = () =>
      newStream.getTracks().length === 0 && this.handleRemoveStream(newStream)
    const { name, stream } = Object.assign(
      (this.#streams[newStream.id] ??= {}),
      { stream: newStream }
    )
    if (name && stream) {
      logStreaming('<< Added %s (%s)', name, stream.id)
      this.emit('add-stream', name, stream)
    }
  }

  private handleRemoveStream(stream: MediaStream, local = false) {
    if (local) {
      logStreaming('>> Removed %s', stream.id)
      const senders = this.#pc.getSenders()
      stream.getTracks().forEach(track => {
        track.stop()
        const sender = senders.find(sender => sender.track?.id === track.id)
        if (!sender) return
        this.#pc.removeTrack(sender)
      })
      return
    }
    logStreaming('<< Removed %s', stream.id)
    delete this.#streams[stream.id]
    this.emit('remove-stream', stream.id)
  }

  get streams() {
    return Object.values(this.#streams)
  }

  get streamNames() {
    return this.streams.map(({ name }) => name)
  }

  get isOpen() {
    return this.#pc != null && this.#pc.signalingState !== 'closed'
  }

  get stable() {
    return this.#pc != null && this.#pc.signalingState === 'stable'
  }

  get canSignal() {
    return this.isOpen && this.#sc != null && this.#sc.readyState === 'open'
  }

  get isPolite() {
    return this.#polite
  }

  emit<T extends keyof PeerEvents>(
    event: T,
    ...args: EventEmitter.ArgumentMap<PeerEvents>[Extract<T, keyof PeerEvents>]
  ): boolean {
    logEvents('** %s %o', event, args)
    return super.emit(event, ...args)
  }

  private get readyForOffer() {
    return (
      !this.#makingOffer && (this.stable || this.#isSettingRemoteAnswerPending)
    )
  }

  async handleSignal(signal: PeerSignal) {
    logSignaling('<< %s %O', signal.type, signal)
    switch (signal.type) {
      case 'offer':
        if (!this.isOpen) this.createConnection(true)
      case 'answer':
        this.#ignoringOffer =
          !this.#polite && signal.type === 'offer' && !this.readyForOffer
        if (this.#ignoringOffer) return
        this.#isSettingRemoteAnswerPending = signal.type === 'answer'
        await this.#pc.setRemoteDescription(signal)
        this.#isSettingRemoteAnswerPending = false
        if (signal.type === 'offer') {
          await this.#pc.setLocalDescription()
          this.sendSignal(this.#pc.localDescription!.toJSON())
          const candidates = this.#candidates.splice(0, this.#candidates.length)
          for (const candidate of candidates) {
            try {
              await this.#pc.addIceCandidate(candidate)
            } catch (err) {
              if (!this.#ignoringOffer) throw err
            }
          }
        }
        break
      case 'candidate': {
        if (this.#pc) {
          try {
            await this.#pc.addIceCandidate(signal.candidate)
          } catch (err) {
            if (!this.#ignoringOffer) throw err
          }
        } else this.#candidates.push(signal.candidate)
        break
      }
      case 'stream': {
        const { name, stream } = Object.assign(
          (this.#streams[signal.id] ??= {}),
          { name: signal.name }
        )
        if (name && stream) this.emit('add-stream', name, stream)
        break
      }
      case 'close': {
        this.handleClose()
        break
      }
      case 'identifier': {
        this.#id = signal.id
        break
      }
    }
  }

  private handleConnectionStateChange(state: RTCPeerConnectionState) {
    this.emit('connection-state-change', state)
  }

  private handleSignalingStateChange(state: RTCSignalingState) {
    this.emit('signaling-state-change', state)
    if (state !== 'stable') return
    dequeue(this.#streamQueue, ({ name, stream }) => {
      logStreaming('<< %s (%s) dequeued', name, stream.id)
      this.#addStream(name, stream)
    })
  }

  private async handleNegotiation() {
    try {
      this.#negotiated = true
      this.#makingOffer = true
      // const offer = await this.#pc.createOffer({
      //   offerToReceiveAudio: true,
      //   offerToReceiveVideo: true,
      // })
      // if (!this.stable) return
      await this.#pc.setLocalDescription()
      this.sendSignal(this.#pc.localDescription!.toJSON())
    } catch (err) {
      throw err
    } finally {
      this.#makingOffer = false
    }
  }

  private sendSignal(signal: PeerSignal) {
    logSignaling('>> %s %O', signal.type, signal)
    if (this.canSignal) return this.#sc.send(JSON.stringify(signal))
    this.emit('signal', signal)
  }

  private handleChannelStateChange(state: RTCDataChannelState) {
    this.emit('channel-state-change', state)
  }

  private handleDataChannel(channel: RTCDataChannel) {
    if (channel.label !== 'simple-signaling')
      return this.emit('data-channel', channel)
    logSignaling('** Signaling Channel Connected')
    this.#sc = channel
    channel.onclosing =
      channel.onopen =
      channel.onclose =
        () => this.handleChannelStateChange(channel.readyState)
    channel.onmessage = ({ data }) => this.handleSignal(JSON.parse(data))
  }

  private handleIceConnectionStateChange(state: RTCIceConnectionState) {
    this.emit('ice-connection-state-change', state)
    if (state !== 'failed') return
    this.#pc.restartIce()
  }

  private createConnection(polite: boolean = false) {
    this.#polite = polite
    const peer = (this.#pc = new RTCPeerConnection(this.#options))
    peer.onconnectionstatechange = () =>
      this.handleConnectionStateChange(peer.connectionState)
    peer.onsignalingstatechange = () =>
      this.handleSignalingStateChange(peer.signalingState)
    peer.onnegotiationneeded = () => this.handleNegotiation()
    peer.onicecandidate = ({ candidate }) => {
      if (!candidate) return
      this.sendSignal({ type: 'candidate', candidate: candidate.toJSON() })
    }
    peer.ondatachannel = ({ channel }) => this.handleDataChannel(channel)
    peer.ontrack = ({ track, streams }) => {
      const stream = streams?.[0]
      if (stream)
        track.onunmute = () => {
          if (this.#streams[stream.id]?.stream) return
          this.handleAddStream(stream)
        }
      else this.handleAddStream(new MediaStream([track]))
    }
    peer.oniceconnectionstatechange = () =>
      this.handleIceConnectionStateChange(peer.iceConnectionState)

    dequeue(this.#streamQueue, ({ name, stream }) => {
      logStreaming('<< %s (%s) dequeued', name, stream.id)
      this.#addStream(name, stream)
    })
    dequeue(this.#channelQueue, label => {
      logChannels('>> %s dequeued', label)
      this.#createDataChannel(label)
    })
  }
}

export type PeerSignal =
  | { type: Exclude<RTCSdpType, 'rollback'>; sdp?: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit }
  | { type: 'stream'; name: string; id: string }
  | { type: 'close' }
  | { type: 'identifier'; id: string }

export interface PeerEvents {
  'signal': (signal: PeerSignal) => void
  'channel-state-change': (state: RTCDataChannelState) => void
  'data-channel': (channel: RTCDataChannel) => void
  'signaling-state-change': (state: RTCSignalingState) => void
  'connection-state-change': (state: RTCPeerConnectionState) => void
  'add-stream': (name: string, stream: MediaStream) => void
  'remove-stream': (id: string) => void
  'ice-connection-state-change': (state: RTCIceConnectionState) => void
}
