import debug from 'debug'
import EventEmitter from 'eventemitter3'

const log = debug('simple-peer')

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

  constructor(options: RTCConfiguration = {}) {
    super()
    this.#options = options
  }

  createDataChannel(label: string) {
    if (!this.isOpen) {
      this.#channelQueue.push(label)
      return
    }
    this.handleDataChannel(this.#pc.createDataChannel(label))
  }

  open() {
    if (this.isOpen) return
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
    this.handleClose()
    this.sendSignal({ type: 'close' })
  }

  private handleClose() {
    this.#pc.close()
    this.emit('connection-state-change', this.#pc.connectionState)
    this.emit('signaling-state-change', this.#pc.signalingState)
  }

  addStream(name: string, stream: MediaStream) {
    if (!this.stable) {
      this.#streamQueue.push({ name, stream })
      return
    }
    this.handleAddStream(stream, true)
    this.sendSignal({ type: 'stream', id: stream.id, name })
  }

  removeStream(stream: MediaStream) {
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
    if (name && stream) this.emit('add-stream', name, stream)
  }

  private handleRemoveStream(stream: MediaStream, local = false) {
    if (local) {
      const senders = this.#pc.getSenders()
      stream.getTracks().forEach(track => {
        track.stop()
        const sender = senders.find(sender => sender.track?.id === track.id)
        if (!sender) return
        this.#pc.removeTrack(sender)
      })
      return
    }
    delete this.#streams[stream.id]
    this.emit('remove-stream', stream.id)
  }

  get isOpen() {
    return this.#pc != null && this.#pc.signalingState !== 'closed'
  }

  get stable() {
    return this.#pc != null && this.#pc.signalingState === 'stable'
  }

  get canSignal() {
    return this.#sc != null && this.#sc.readyState === 'open'
  }

  emit<T extends keyof PeerEvents>(
    event: T,
    ...args: EventEmitter.ArgumentMap<PeerEvents>[Extract<T, keyof PeerEvents>]
  ): boolean {
    log('** %s %o', event, args)
    return super.emit(event, ...args)
  }

  async handleSignal(signal: PeerSignal) {
    log('<< %o', signal)
    switch (signal.type) {
      case 'offer': {
        if (!this.isOpen) this.createConnection()
        await this.#pc.setRemoteDescription(signal)
        const answer = await this.#pc.createAnswer()
        await this.#pc.setLocalDescription(answer)
        this.sendSignal(this.#pc.localDescription!.toJSON())
        const candidates = this.#candidates.splice(0, this.#candidates.length)
        for (const candidate of candidates)
          await this.#pc.addIceCandidate(candidate)
        break
      }
      case 'answer': {
        await this.#pc.setRemoteDescription(signal)
        break
      }
      case 'candidate': {
        if (this.#pc) await this.#pc.addIceCandidate(signal.candidate)
        else this.#candidates.push(signal.candidate)
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
    }
  }

  private handleConnectionStateChange(state: RTCPeerConnectionState) {
    this.emit('connection-state-change', state)
  }

  private handleSignalingStateChange(state: RTCSignalingState) {
    this.emit('signaling-state-change', state)
    if (state !== 'stable') return
    dequeue(this.#streamQueue, ({ name, stream }) => {
      this.handleAddStream(stream, true)
      this.sendSignal({ type: 'stream', id: stream.id, name })
    })
  }

  private async handleNegotiation() {
    this.#negotiated = true
    const offer = await this.#pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    })
    await this.#pc.setLocalDescription(offer)
    this.sendSignal(this.#pc.localDescription!.toJSON())
  }

  private sendSignal(signal: PeerSignal) {
    log('>> %o %s', signal, this.canSignal)
    if (this.canSignal) return this.#sc.send(JSON.stringify(signal))
    this.emit('signal', signal)
  }

  private handleChannelStateChange(state: RTCDataChannelState) {
    this.emit('channel-state-change', state)
  }

  private handleDataChannel(channel: RTCDataChannel) {
    if (channel.label !== 'simple-signaling')
      return this.emit('data-channel', channel)
    this.#sc = channel
    channel.onclosing =
      channel.onopen =
      channel.onclose =
        () => this.handleChannelStateChange(channel.readyState)
    channel.onmessage = ({ data }) => this.handleSignal(JSON.parse(data))
  }

  private createConnection() {
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
    peer.ontrack = ({ track, streams }) =>
      this.handleAddStream(streams?.[0] ?? new MediaStream([track]))

    dequeue(this.#streamQueue, ({ name, stream }) => {
      this.handleAddStream(stream, true)
      this.sendSignal({ type: 'stream', id: stream.id, name })
    })
    dequeue(this.#channelQueue, label =>
      this.handleDataChannel(this.#pc.createDataChannel(label))
    )
  }
}

export type PeerSignal =
  | RTCSessionDescriptionInit
  | { type: 'candidate'; candidate: RTCIceCandidateInit }
  | { type: 'stream'; name: string; id: string }
  | { type: 'close' }

export interface PeerEvents {
  'signal': (signal: PeerSignal) => void
  'channel-state-change': (state: RTCDataChannelState) => void
  'data-channel': (channel: RTCDataChannel) => void
  'signaling-state-change': (state: RTCSignalingState) => void
  'connection-state-change': (state: RTCPeerConnectionState) => void
  'add-stream': (name: string, stream: MediaStream) => void
  'remove-stream': (id: string) => void
}
