"use client";

import { useState, useRef, useEffect } from "react";
import { ChatMessage } from "./_components/ChatMessage";
import { ProofGenerator } from "./_components/ProofGenerator";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const API_SERVER = process.env.NEXT_PUBLIC_API_SERVER || "http://localhost:3001";

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [proofData, setProofData] = useState<{
    proof: string;
    nullifier_hash: string;
    root: string;
    depth: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || !proofData || isLoading) return;

    const userMessage: Message = { role: "user", content: input.trim() };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`${API_SERVER}/v1/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proof: proofData.proof,
          nullifier_hash: proofData.nullifier_hash,
          root: proofData.root,
          depth: proofData.depth,
          messages: updatedMessages,
          model: "hermes-3-llama-3.1-405b",
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: "Request failed" }));
        throw new Error(errData.error || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const assistantContent =
        data.choices?.[0]?.message?.content || "No response from model.";

      setMessages([...updatedMessages, { role: "assistant", content: assistantContent }]);

      // After successful use, clear proof (it's single-use)
      setProofData(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center pt-6 px-4 h-[calc(100vh-80px)]">
      <h1 className="text-3xl font-bold mb-4">💬 Anonymous Chat</h1>

      <div className="w-full max-w-3xl flex flex-col flex-grow gap-4 min-h-0">
        {/* Proof Generator */}
        <ProofGenerator
          onProofGenerated={setProofData}
          hasProof={!!proofData}
        />

        {/* Messages */}
        <div className="flex-grow overflow-y-auto bg-base-200 rounded-xl p-4 space-y-4 min-h-[200px]">
          {messages.length === 0 && (
            <div className="text-center opacity-50 mt-10">
              <p className="text-lg">No messages yet</p>
              <p className="text-sm">Generate a proof above, then start chatting</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <ChatMessage key={i} message={msg} />
          ))}
          {isLoading && (
            <div className="flex gap-2 items-center opacity-70">
              <span className="loading loading-dots loading-sm"></span>
              <span>Thinking...</span>
            </div>
          )}
          {error && (
            <div className="alert alert-error">
              <span>{error}</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder={proofData ? "Type your message..." : "Generate a proof first"}
            className="input input-bordered flex-grow"
            disabled={!proofData || isLoading}
          />
          <button
            className="btn btn-primary"
            onClick={handleSend}
            disabled={!proofData || !input.trim() || isLoading}
          >
            Send
          </button>
        </div>

        {!proofData && messages.length > 0 && (
          <div className="alert alert-info">
            <span>Each message requires a new proof. Generate another proof above to continue chatting.</span>
          </div>
        )}
      </div>
    </div>
  );
}
