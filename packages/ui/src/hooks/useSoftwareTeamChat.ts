import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export interface ChatMessage {
  id: string;
  softwareTeamId: string;
  sender: string;
  kind: string;
  body: string;
  topic: string | null;
  createdAt: string;
}

async function fetchChatHistory(softwareTeamId: string): Promise<ChatMessage[]> {
  const res = await fetch(`/api/software-teams/${encodeURIComponent(softwareTeamId)}/chat/history?limit=50`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function sendChatMessage(softwareTeamId: string, body: string, sender: string): Promise<ChatMessage> {
  const res = await fetch(`/api/software-teams/${encodeURIComponent(softwareTeamId)}/chat/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, body }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useSoftwareTeamChat(softwareTeamId: string) {
  const queryClient = useQueryClient();

  const historyQuery = useQuery({
    queryKey: ["softwareTeam", softwareTeamId, "chat"],
    queryFn: () => fetchChatHistory(softwareTeamId),
    enabled: !!softwareTeamId,
  });

  const sendMutation = useMutation({
    mutationFn: ({ body, sender }: { body: string; sender: string }) =>
      sendChatMessage(softwareTeamId, body, sender),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["softwareTeam", softwareTeamId, "chat"] });
    },
  });

  // SSE live updates — listen for chat.message events
  useEffect(() => {
    if (!softwareTeamId) return;

    const es = new EventSource(`/api/software-teams/${encodeURIComponent(softwareTeamId)}/chat/watch`);

    es.addEventListener("message", () => {
      // Invalidate to refetch on new messages
      queryClient.invalidateQueries({ queryKey: ["softwareTeam", softwareTeamId, "chat"] });
    });

    return () => {
      es.close();
    };
  }, [softwareTeamId, queryClient]);

  return {
    messages: historyQuery.data ?? [],
    isLoading: historyQuery.isPending,
    error: historyQuery.error,
    send: sendMutation.mutate,
    isSending: sendMutation.isPending,
  };
}
