import { Action, ActionPanel, useNavigation, Detail, Clipboard, open, List } from "@raycast/api";
import { useState } from "react";

interface MemeResponse {
  id: string;
  image_path: string;
  image_url: string;
}

export default function Command() {
  const [meme, setMeme] = useState<MemeResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const { push } = useNavigation();

  const fetchMeme = async () => {
    setIsLoading(true);
    try {
      const response = await fetch("http://localhost:3000/random-meme");
      const data = (await response.json()) as MemeResponse;
      setMeme(data);
      push(<MemeDetail meme={data} onGetAnother={fetchMeme} />);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <List isLoading={isLoading}>
      <List.Item
        title="Get Random Meme"
        subtitle="Tap to get a random meme from the server"
        actions={
          <ActionPanel>
            <Action title="Get Meme" onAction={fetchMeme} />
          </ActionPanel>
        }
      />
    </List>
  );
}

function MemeDetail({ meme, onGetAnother }: { meme: MemeResponse; onGetAnother: () => void }) {
  const imageUrl = `http://localhost:3000${meme.image_url}`;

  return (
    <Detail
      markdown={`![Meme](${imageUrl})`}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Image URL" content={imageUrl} />
          <Action
            title="Open in Browser"
            onAction={() => open(imageUrl)}
          />
          <Action
            title="Save Image As..."
            onAction={() => {
              Clipboard.copy(imageUrl);
            }}
          />
          <Action
            title="Get Another Meme"
            onAction={onGetAnother}
          />
        </ActionPanel>
      }
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="File" text={meme.image_path} />
        </Detail.Metadata>
      }
    />
  );
}