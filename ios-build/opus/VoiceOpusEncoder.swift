import AVFoundation

/// paseo-voice: the microphone's speech as Opus, for the daemon.
///
/// Voice mode streams the microphone to the daemon for as long as it is on and unmuted:
/// 16 kHz PCM16 is 32 KB a second, about 340 kbit/s once base64 has had its way — more
/// than a weak mobile uplink carries, and then nothing said is heard. Opus at 24 kbit/s is
/// a tenth of it, and iOS encodes it itself through AudioToolbox, so nothing is linked in.
///
/// One instance per voice session: Opus is a stream, and the encoder keeps state between
/// calls. Samples short of a whole 20 ms packet wait for the next call. Every packet goes
/// out prefixed with its length, a little-endian UInt16, which is what the daemon reads.
///
/// Written into Paseo's `expo-two-way-audio` module by `ios-build/patch-app.mjs`, and
/// compiled for macOS as it is by `e2e/opus-encoder.e2e.ts`, which decodes what it makes.
final class VoiceOpusEncoder {
  static let sampleRate = 16_000.0
  /// 20 ms: Opus's own default, and a packet small enough that losing one is a click.
  static let framesPerPacket: AVAudioFrameCount = 320
  static let bitRate = 24_000

  private let pcmFormat: AVAudioFormat
  private let opusFormat: AVAudioFormat
  private let converter: AVAudioConverter
  private var pending = Data()

  init?() {
    guard
      let pcm = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: Self.sampleRate, channels: 1, interleaved: true)
    else { return nil }
    var description = AudioStreamBasicDescription(
      mSampleRate: Self.sampleRate, mFormatID: kAudioFormatOpus, mFormatFlags: 0, mBytesPerPacket: 0,
      mFramesPerPacket: Self.framesPerPacket, mBytesPerFrame: 0, mChannelsPerFrame: 1,
      mBitsPerChannel: 0, mReserved: 0)
    guard
      let opus = AVAudioFormat(streamDescription: &description),
      let converter = AVAudioConverter(from: pcm, to: opus)
    else { return nil }
    converter.bitRate = Self.bitRate
    self.pcmFormat = pcm
    self.opusFormat = opus
    self.converter = converter
  }

  /// Every whole packet the PCM handed in so far makes, length-prefixed: empty while less
  /// than a packet has built up, nil if the encoder failed and PCM should go instead.
  func encode(_ pcm: Data) -> Data? {
    pending.append(pcm)
    let perPacket = Int(Self.framesPerPacket)
    let frames = (pending.count / 2) / perPacket * perPacket
    if frames == 0 {
      return Data()
    }
    guard let input = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: AVAudioFrameCount(frames)),
      let samples = input.int16ChannelData
    else { return nil }
    input.frameLength = AVAudioFrameCount(frames)
    pending.withUnsafeBytes { raw in
      _ = memcpy(samples[0], raw.baseAddress!, frames * 2)
    }
    pending = Data(pending.dropFirst(frames * 2))

    let output = AVAudioCompressedBuffer(
      format: opusFormat, packetCapacity: AVAudioPacketCount(frames / perPacket + 2),
      maximumPacketSize: max(converter.maximumOutputPacketSize, 1_500))
    var handedOver = false
    var failure: NSError?
    // `noDataNow`, never `endOfStream`: the stream goes on, and the encoder keeps what it
    // holds back for the next call.
    let status = converter.convert(to: output, error: &failure) { _, inputStatus in
      if handedOver {
        inputStatus.pointee = .noDataNow
        return nil
      }
      handedOver = true
      inputStatus.pointee = .haveData
      return input
    }
    if status == .error || failure != nil {
      return nil
    }

    var packed = Data()
    guard let descriptions = output.packetDescriptions else { return packed }
    for index in 0..<Int(output.packetCount) {
      let packet = descriptions[index]
      var size = UInt16(packet.mDataByteSize).littleEndian
      packed.append(Data(bytes: &size, count: 2))
      packed.append(Data(bytes: output.data.advanced(by: Int(packet.mStartOffset)), count: Int(packet.mDataByteSize)))
    }
    return packed
  }
}
