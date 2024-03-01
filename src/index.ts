import debug from 'debug'
import EventEmitter from 'eventemitter3'

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

export interface SimplePeerOptions {
  /**
   * Configuration options for the RTCPeerConnection.
   *
   * {@link https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection MDN Reference}
   */
  rtc?: RTCConfiguration
  /**
   * Configure how long we should wait before giving up on a failed connection.
   *
   * If 0 is provided then never give up the connection.
   */
  timeout?: number
}

export default class SimplePeer extends EventEmitter<PeerEvents> {
  #pc!: RTCPeerConnection
  #negotiated: boolean = false
  #sc!: RTCDataChannel
  #candidates: RTCIceCandidateInit[] = []
  #streams: Record<string, { name?: string; stream?: MediaStream }> = {}
  #streamQueue: { name: string; stream: MediaStream }[] = []
  #channelQueue: { label: string; dataChannelDict?: RTCDataChannelInit }[] = []
  #timeout?: NodeJS.Timeout
  #polite = false
  #ignoringOffer = false
  #makingOffer = false
  #isSettingRemoteAnswerPending = false
  #options

  /**
   * @param options
   */
  constructor(options?: SimplePeerOptions) {
    super()
    this.#options = {
      timeout: options?.timeout ?? 5000,
      rtc: options?.rtc,
    }
  }

  /**
   * Creates a new data channel with the given label for streaming data across the WebRTC Connection.
   *
   * {@link https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createDataChannel MDN Reference}
   * @param label
   * @param dataChannelDict
   * @returns
   */
  createDataChannel(label: string, dataChannelDict?: RTCDataChannelInit) {
    if (!this.isOpen) {
      logChannels('>> %s enqueued %o', label, dataChannelDict)
      this.#channelQueue.push({ label, dataChannelDict })
      return
    }
    return this.#createDataChannel(label, dataChannelDict)
  }

  #createDataChannel(label: string, dataChannelDict?: RTCDataChannelInit) {
    logChannels('** %s created %o', label, dataChannelDict)
    this.handleDataChannel(this.#pc.createDataChannel(label, dataChannelDict))
  }

  /**
   * Open the RTCPeerConnection and begin negotiation.
   * @returns
   */
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

  /**
   * Close the RTCPeerConnection
   * @returns
   */
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

  /**
   * Add a MediaStream to the RTCPeerConnection for streaming audio and video.
   * @param name
   * @param stream
   * @returns
   */
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

  /**
   * Remove a MediaStream from the RTCPeerConnection.
   *
   * This will stop local and remote playback.
   * @param stream
   * @returns
   */
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

  /**
   * An array of incoming MediaStreams
   */
  get streams() {
    return Object.values(this.#streams)
  }

  /**
   * An array of incoming MediaStream names
   */
  get streamNames() {
    return this.streams.map(({ name }) => name)
  }

  /**
   * Whether the RTCPeerConnection's signalingState is not closed
   */
  get isOpen() {
    return this.#pc != null && this.#pc.signalingState !== 'closed'
  }

  /**
   * Whether the RTCPeerConnection's signalingState is stable
   */
  get stable() {
    return this.#pc != null && this.#pc.signalingState === 'stable'
  }

  /**
   * Whether the signaling channel's readyState is open
   */
  get canSignal() {
    return this.isOpen && this.#sc != null && this.#sc.readyState === 'open'
  }

  /**
   * Whether the peer is polite
   *
   * If the peer is polite it will concede when a signal collision occurs
   */
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

  /**
   * Processes the signals received from the signaling server.
   * @param signal
   * @returns
   */
  async handleSignal(signal: PeerSignal) {
    logSignaling('<< %s %O', signal.type, signal)
    switch (signal.type) {
      case 'offer':
        if (!this.isOpen) this.createConnection(true)
      case 'answer':
        this.#ignoringOffer =
          !this.#polite && signal.type === 'offer' && !this.readyForOffer
        if (this.#ignoringOffer) return
        this.stopAnswerTimeout()
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

  private startAnswerTimeout() {
    this.stopAnswerTimeout()
    if (!this.#options?.timeout) return
    this.#timeout = setTimeout(() => this.close(), this.#options.timeout)
  }

  private stopAnswerTimeout() {
    if (!this.#timeout) return
    clearTimeout(this.#timeout)
    this.#timeout = undefined
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
      this.startAnswerTimeout()
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
    const peer = (this.#pc = new RTCPeerConnection(this.#options?.rtc))
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
    dequeue(this.#channelQueue, ({ label, dataChannelDict }) => {
      logChannels('>> %s dequeued %o', label, dataChannelDict)
      this.#createDataChannel(label, dataChannelDict)
    })
  }
}

export type PeerSignal =
  | { type: Exclude<RTCSdpType, 'rollback'>; sdp?: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit }
  | { type: 'stream'; name: string; id: string }
  | { type: 'close' }

export interface PeerEvents {
  /**
   * Fired when a signal can't be transported internally via the signaling channel.
   * @param signal
   * @returns
   */
  'signal': (signal: PeerSignal) => void
  /**
   * Fired when the signaling channel's readyState changes.
   * @param state
   * @returns
   */
  'channel-state-change': (state: RTCDataChannelState) => void
  /**
   * Fired when a RTCDataChannel is created or received.
   * @param channel
   * @returns
   */
  'data-channel': (channel: RTCDataChannel) => void
  /**
   * Fired when the RTCPeerConnection's signalingState changes.
   * @param state
   * @returns
   */
  'signaling-state-change': (state: RTCSignalingState) => void
  /**
   * Fired when the RTCPeerConnection's connectionState changes.
   * @param state
   * @returns
   */
  'connection-state-change': (state: RTCPeerConnectionState) => void
  /**
   * Fired when a MediaStream is received.
   * @param name
   * @param stream
   * @returns
   */
  'add-stream': (name: string, stream: MediaStream) => void
  /**
   * Fired when a received MediaStream is removed.
   * @param id
   * @returns
   */
  'remove-stream': (id: string) => void
  /**
   * Fired when the RTCPeerConnection's iceConnectionState changes.
   * @param state
   * @returns
   */
  'ice-connection-state-change': (state: RTCIceConnectionState) => void
}
