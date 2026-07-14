/**
 * Ymodem protocol sender for SBC firmware upgrade.
 *
 * Implements the host (PC) side of the Ymodem-1K protocol, matching the
 * bootloader's simplified Ymodem implementation in common/iap/iap.c.
 *
 * Protocol constants and behavior are derived from the bootloader source:
 *   common/iap/iap.h  — SOH/STX/EOT/ACK/NAK/CA/MODEM_C definitions
 *   common/iap/iap.c  — siapproc() state machine, ymodemcrc()
 */

// ========== Ymodem Protocol Constants ==========
const SOH      = 0x01;   // start of 128-byte data packet
const STX      = 0x02;   // start of 1024-byte data packet
const EOT      = 0x04;   // end of transmission
const ACK      = 0x06;   // acknowledge
const NAK      = 0x15;   // negative acknowledge
const CA       = 0x18;   // cancel (two in succession aborts transfer)
const MODEM_C  = 0x43;   // 'C' — request 16-bit CRC transfer mode

const PACKET_SIZE  = 1024;        // Ymodem-1K data payload
const PACKET0_PAYLOAD = 128;      // Packet #0 uses SOH = 128-byte payload
const HEADER_SIZE = 3;            // [SOH/STX] [seq] [~seq]
const CRC_SIZE    = 2;            // 16-bit CRC

// Full packet sizes (header + payload + CRC)
const PACKET0_SIZE = 1 + 1 + 1 + PACKET0_PAYLOAD + 2;   // 133 bytes
const DATA_PACKET_SIZE = 1 + 1 + 1 + PACKET_SIZE + 2;   // 1029 bytes

// ========== CRC-16 CCITT (XMODEM variant) ==========

/**
 * Compute CRC-16/CCITT (polynomial 0x1021, initial value 0x0000).
 * This matches the bootloader's ymodemcrc() in common/iap/iap.c.
 *
 * The CRC is computed over the packet PAYLOAD only — i.e. starting from
 * byte index 3 of the full packet (after SOH/STX + seq + ~seq header).
 *
 * @param {Buffer} buf — data buffer
 * @param {number} offset — start offset for CRC calculation
 * @param {number} len — number of bytes to include in CRC
 * @returns {number} 16-bit CRC value (0–65535)
 */
function crc16xmodem(buf, offset, len) {
  let crc = 0;
  const end = offset + len;

  for (let i = offset; i < end; i++) {
    crc = crc ^ ((buf[i] & 0xFF) << 8);
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) >>> 0;
      } else {
        crc = (crc << 1) >>> 0;
      }
    }
  }

  return crc & 0xFFFF;
}

// ========== YmodemSender Class ==========

class YmodemSender {
  /**
   * @param {Buffer} fileBuffer — complete firmware binary
   * @param {string} fileName  — short file name (e.g. "sbc_app.bin")
   */
  constructor(fileBuffer, fileName) {
    this.fileBuffer = fileBuffer;
    this.fileSize = fileBuffer.length;
    this.fileName = fileName;

    this.seq = 0;          // packet sequence number (0 for Packet #0, wraps at 256)
    this.offset = 0;       // bytes of firmware data sent so far
    this.totalPackets = Math.ceil(this.fileSize / PACKET_SIZE) + 1; // +1 for Packet #0
    this.packetsSent = 0;  // count of data packets actually sent
  }

  /**
   * Build Ymodem Packet #0 (file information packet).
   *
   * Structure (133 bytes total):
   *   [0]    = SOH (0x01)
   *   [1]    = 0x00 (sequence number)
   *   [2]    = 0xFF (complement of sequence number)
   *   [3..130] = 128-byte payload:
   *              filename\0 + fileSize_decimal\0 + zero-padding
   *   [131-132] = CRC-16 of bytes [3..130] (MSB first)
   *
   * @returns {Buffer} 133-byte packet
   */
  buildPacket0() {
    // Build 128-byte payload
    const payload = Buffer.alloc(PACKET0_PAYLOAD, 0);

    // Write filename (null-terminated)
    const nameBytes = Buffer.from(this.fileName, 'ascii');
    const nameLen = Math.min(nameBytes.length, PACKET0_PAYLOAD - 2); // leave room for null + size
    nameBytes.copy(payload, 0, 0, nameLen);
    let pos = nameLen;
    payload[pos] = 0x00;           // null terminator for filename
    pos++;

    // Write file size as ASCII decimal (matching bootloader's YMODEM_SECURECRT path)
    const sizeStr = this.fileSize.toString(10);
    const sizeBytes = Buffer.from(sizeStr, 'ascii');
    const sizeLen = Math.min(sizeBytes.length, PACKET0_PAYLOAD - pos - 1);
    sizeBytes.copy(payload, pos, 0, sizeLen);
    pos += sizeLen;
    payload[pos] = 0x00;           // null terminator for file size

    // Remaining bytes are already zero-padded from Buffer.alloc()

    // Compute CRC-16 over payload
    const crc = crc16xmodem(payload, 0, PACKET0_PAYLOAD);

    // Assemble full packet
    const packet = Buffer.alloc(PACKET0_SIZE);
    packet[0] = SOH;
    packet[1] = 0x00;
    packet[2] = 0xFF;
    payload.copy(packet, 3);
    packet[PACKET0_SIZE - 2] = (crc >> 8) & 0xFF;   // CRC high byte
    packet[PACKET0_SIZE - 1] = crc & 0xFF;          // CRC low byte

    return packet;
  }

  /**
   * Build the next Ymodem data packet (STX, 1024-byte payload).
   *
   * Structure (1029 bytes total):
   *   [0]       = STX (0x02)
   *   [1]       = seq & 0xFF
   *   [2]       = (~seq) & 0xFF
   *   [3..1026] = 1024 bytes of firmware data
   *   [1027-1028] = CRC-16 of bytes [3..1026] (MSB first)
   *
   * The last packet is padded with 0xFF (erased flash value) to 1024 bytes.
   *
   * @returns {Buffer|null} 1029-byte data packet, or null if all data sent
   */
  nextDataPacket() {
    if (this.offset >= this.fileSize) {
      return null;
    }

    this.seq = (this.seq + 1) % 256;

    // Build 1024-byte payload
    const payload = Buffer.alloc(PACKET_SIZE, 0xFF); // pad with 0xFF
    const remaining = this.fileSize - this.offset;
    const copyLen = Math.min(remaining, PACKET_SIZE);
    this.fileBuffer.copy(payload, 0, this.offset, this.offset + copyLen);

    // Compute CRC-16 over payload
    const crc = crc16xmodem(payload, 0, PACKET_SIZE);

    // Assemble full packet
    const packet = Buffer.alloc(DATA_PACKET_SIZE);
    packet[0] = STX;
    packet[1] = this.seq & 0xFF;
    packet[2] = (~this.seq) & 0xFF;
    payload.copy(packet, 3);
    packet[DATA_PACKET_SIZE - 2] = (crc >> 8) & 0xFF;  // CRC high byte
    packet[DATA_PACKET_SIZE - 1] = crc & 0xFF;          // CRC low byte

    this.offset += copyLen;
    this.packetsSent++;

    return packet;
  }

  /**
   * @returns {boolean} true when all firmware data has been sent
   */
  isComplete() {
    return this.offset >= this.fileSize;
  }

  /**
   * @returns {{offset: number, total: number, percent: number, packetsSent: number, totalPackets: number}}
   */
  getProgress() {
    return {
      offset: this.offset,
      total: this.fileSize,
      percent: this.fileSize > 0 ? Math.floor(this.offset * 100 / this.fileSize) : 100,
      packetsSent: this.packetsSent,
      totalPackets: this.totalPackets
    };
  }

  /**
   * Build the last data packet again for retransmission.
   * Does NOT advance any internal state (offset, seq, packetsSent).
   *
   * @returns {Buffer|null} 1029-byte data packet, or null if no data has been sent yet
   */
  resendLastDataPacket() {
    if (this.packetsSent === 0) return null;

    // Compute the start offset of the last packet
    const lastStart = this.offset - Math.min(PACKET_SIZE, this.offset - (this.packetsSent - 1) * PACKET_SIZE);
    // Simpler: last packet started at (packetsSent - 1) * PACKET_SIZE into file
    const pktStart = (this.packetsSent - 1) * PACKET_SIZE;

    const payload = Buffer.alloc(PACKET_SIZE, 0xFF);
    const remaining = this.fileSize - pktStart;
    const copyLen = Math.min(remaining, PACKET_SIZE);
    this.fileBuffer.copy(payload, 0, pktStart, pktStart + copyLen);

    const crc = crc16xmodem(payload, 0, PACKET_SIZE);

    const packet = Buffer.alloc(DATA_PACKET_SIZE);
    packet[0] = STX;
    packet[1] = this.seq & 0xFF;
    packet[2] = (~this.seq) & 0xFF;
    payload.copy(packet, 3);
    packet[DATA_PACKET_SIZE - 2] = (crc >> 8) & 0xFF;
    packet[DATA_PACKET_SIZE - 1] = crc & 0xFF;

    return packet;
  }
}

// ========== Exports ==========
module.exports = {
  // Constants
  SOH,
  STX,
  EOT,
  ACK,
  NAK,
  CA,
  MODEM_C,
  PACKET_SIZE,
  PACKET0_SIZE,
  DATA_PACKET_SIZE,

  // Functions
  crc16xmodem,

  // Class
  YmodemSender
};
