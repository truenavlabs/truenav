// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

/// Synthetic-data testnet mirror. The NEAR contract and its MPC-derived address authorize updates.
contract TrueNavMirror {
    address public immutable mpc;
    struct Receipt {
        uint256 seq;
        bytes32 receiptHash;
        uint8 score;
        uint8 band;
        bytes32 methodIdHash;
        uint64 asOfMs;
    }
    mapping(bytes32 => Receipt) public latest;
    event ReceiptUpdated(bytes32 indexed tokenIdHash, uint256 seq, bytes32 receiptHash,
        uint8 score, uint8 band, bytes32 methodIdHash, uint64 asOfMs);
    constructor(address derivedAddress) {
        require(block.chainid == 84532, "Base Sepolia only");
        require(derivedAddress != address(0), "zero MPC");
        mpc = derivedAddress;
    }
    function update(bytes32 tokenIdHash, uint256 seq, bytes32 receiptHash,
        uint8 score, uint8 band, bytes32 methodIdHash, uint64 asOfMs) external {
        require(msg.sender == mpc, "MPC only");
        require(seq > latest[tokenIdHash].seq, "sequence must increase");
        require(score <= 100 && band == (score >= 85 ? 2 : score >= 60 ? 1 : 0), "score/band mismatch");
        latest[tokenIdHash] = Receipt(seq, receiptHash, score, band, methodIdHash, asOfMs);
        emit ReceiptUpdated(tokenIdHash, seq, receiptHash, score, band, methodIdHash, asOfMs);
    }
}
