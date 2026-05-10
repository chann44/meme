import { Action, ActionPanel, useNavigation, Detail, open, Grid, showToast, Toast } from "@raycast/api";
import { useState, useEffect, useRef } from "react";

interface Meme {
  id: string;
  image_path: string;
  caption?: string;
  primary_language?: string;
  emotion?: string;
  regions?: string[];
  intent?: string;
  similarity?: number;
}

const API_BASE = "http://localhost:3000";

export default function Command() {
  const [memes, setMemes] = useState<Meme[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchText, setSearchText] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { push } = useNavigation();

  useEffect(() => {
    if (!searchText.trim()) {
      setMemes([]);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      setIsLoading(true);
      try {
        const response = await fetch(`${API_BASE}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: searchText, limit: 20 }),
        });
        const data = (await response.json()) as { memes: Meme[]; error?: string };
        if (data.error) throw new Error(data.error);
        setMemes(data.memes ?? []);
      } catch (err) {
        await showToast({ style: Toast.Style.Failure, title: "Search failed", message: String(err) });
        setMemes([]);
      } finally {
        setIsLoading(false);
      }
    }, 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchText]);

  return (
    <Grid isLoading={isLoading} searchBarPlaceholder="Search memes..." onSearchTextChange={setSearchText}>
      <Grid.EmptyView
        title={searchText ? "No memes found" : "Search for memes"}
        description={searchText ? "Try a different query" : "Type something to find the perfect meme"}
      />
      {memes.map((meme) => (
        <Grid.Item
          key={meme.id}
          content={`${API_BASE}/${meme.image_path}`}
          title={meme.caption ?? meme.image_path}
          subtitle={meme.emotion}
          actions={
            <ActionPanel>
              <Action title="View Details" onAction={() => push(<MemeDetail meme={meme} />)} />
            </ActionPanel>
          }
        />
      ))}
    </Grid>
  );
}

function MemeDetail({ meme }: { meme: Meme }) {
  const imageUrl = `${API_BASE}/${meme.image_path}`;

  return (
    <Detail
      markdown={`![Meme](${imageUrl})`}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Image URL" content={imageUrl} />
          <Action.Paste title="Paste Image URL" content={imageUrl} />
          <Action title="Open in Browser" onAction={() => open(imageUrl)} />
        </ActionPanel>
      }
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="File" text={meme.image_path} />
          {meme.caption && <Detail.Metadata.Label title="Caption" text={meme.caption} />}
          {meme.emotion && <Detail.Metadata.Label title="Emotion" text={meme.emotion} />}
          {meme.primary_language && <Detail.Metadata.Label title="Language" text={meme.primary_language} />}
          {meme.regions && meme.regions.length > 0 && (
            <Detail.Metadata.TagList title="Regions">
              {meme.regions.map((r) => (
                <Detail.Metadata.TagList.Item key={r} text={r} />
              ))}
            </Detail.Metadata.TagList>
          )}
          {meme.intent && <Detail.Metadata.Label title="Intent" text={meme.intent} />}
          {meme.similarity !== undefined && (
            <Detail.Metadata.Label title="Match" text={`${Math.round(meme.similarity * 100)}%`} />
          )}
        </Detail.Metadata>
      }
    />
  );
}
