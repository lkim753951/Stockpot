// Sends 80 ms blocks of 16-bit mono PCM, plus a loudness value for the steam meter.
class PcmSender extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Int16Array(1920)
    this.filled = 0
    this.peak = 0
  }

  process(inputs) {
    const input = inputs[0][0]
    if (!input) return true
    for (let i = 0; i < input.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, input[i]))
      this.peak = Math.max(this.peak, Math.abs(sample))
      this.block[this.filled] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      this.filled += 1
      if (this.filled === this.block.length) {
        const pcm = this.block.slice().buffer
        this.port.postMessage({ pcm, level: this.peak }, [pcm])
        this.filled = 0
        this.peak = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-sender', PcmSender)
