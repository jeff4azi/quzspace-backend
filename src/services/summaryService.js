// services/summaryService.js
// Stub summary / topics service. Real impl reads summaries.data.topics
// from Supabase (join on space_id, take latest). For now, exposes:
//   - getTopics(spaceId) -> { status, topics }
//   - supports simulate_pending flag to trigger 425 for UI polling tests

const DEFAULT_TOPICS = [
  "OSI Model Layers",
  "TCP/IP Stack",
  "Encapsulation Process",
  "IPv4 Addressing",
  "Subnetting & CIDR",
  "TCP Handshake",
  "TCP Flow Control",
  "UDP Datagrams",
  "Routing & Hops",
  "DNS Resolution",
  "MAC & Link Layer",
  "Network Security Basics",
  "Wireless Fundamentals",
  "Latency vs Throughput",
];

function summaryService() {
  return {
    getTopics(spaceId, { simulatePending = false } = {}) {
      if (simulatePending) {
        return {
          status: "not_generated",
          topics: [],
          retry_after_ms: 1500,
        };
      }
      return {
        status: "ready",
        topics: DEFAULT_TOPICS,
      };
    },
  };
}

module.exports = { summaryService };
