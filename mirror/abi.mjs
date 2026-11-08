import { parseAbi } from "viem";
export const CHAIN_ID = 84532;
export const PATH = "truenav-mirror-v1";
export const abi = parseAbi([
  "function update(bytes32 tokenIdHash,uint256 seq,bytes32 receiptHash,uint8 score,uint8 band,bytes32 methodIdHash,uint64 asOfMs)",
  "function latest(bytes32) view returns (uint256 seq,bytes32 receiptHash,uint8 score,uint8 band,bytes32 methodIdHash,uint64 asOfMs)",
  "event ReceiptUpdated(bytes32 indexed tokenIdHash,uint256 seq,bytes32 receiptHash,uint8 score,uint8 band,bytes32 methodIdHash,uint64 asOfMs)",
]);
