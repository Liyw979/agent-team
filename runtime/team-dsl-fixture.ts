export default {
  agents: [
    "Build",
    "BA",
    {
      name: "SecurityResearcher",
      prompt: "你负责漏洞挖掘。",
    },
  ],
  topology: {
    downstream: {
      BA: { Build: "association" },
      Build: { SecurityResearcher: "association" },
      SecurityResearcher: { Build: "needs_revision" },
    },
  },
};
