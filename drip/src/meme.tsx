import { Action, ActionPanel, useNavigation, Detail, Clipboard, open, Grid } from "@raycast/api";
import { useState } from "react";

interface Meme {
  id: string;
  image_path: string;
  image_url: string;
}

export default function Command() {
  const [memes, setMemes] = useState<Meme[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const { push } = useNavigation();

  const fetchMemes = async () => {
    setIsLoading(true);
    try {
      const response = await fetch("http://localhost:3000/memes");
      const data = (await response.json()) as { memes: Meme[] };
      setMemes(data.memes);
      if (data.memes.length > 0) {
        push(<MemeGrid memes={data.memes} onRefresh={fetchMemes} />);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Grid
      isLoading={isLoading}
      searchBarPlaceholder="Search memes..."
      onSearchTextChange={(text) => {
        if (text) fetchMemes();
      }}
    >
      <Grid.EmptyView
        title="No Memes Yet"
        description="Type something to search for memes"
        actions={
          <ActionPanel>
            <Action title="Get Memes" onAction={fetchMemes} />
          </ActionPanel>
        }
      />
      {memes.map((meme) => (
        <Grid.Item
          key={meme.id}
          content={`http://localhost:3000${meme.image_url}`}
          title={meme.image_path}
          actions={
            <ActionPanel>
              <Action
                title="View & Save"
                onAction={() => push(<MemeDetail meme={meme} onGetAnother={fetchMemes} />)}
              />
            </ActionPanel>
          }
        />
      ))}
    </Grid>
  );
}

function MemeGrid({ memes, onRefresh }: { memes: Meme[]; onRefresh: () => void }) {
  const { push } = useNavigation();

  return (
    <Grid columns={2}>
      {memes.map((meme) => (
        <Grid.Item
          key={meme.id}
          content={`http://localhost:3000${meme.image_url}`}
          title={meme.image_path}
          actions={
            <ActionPanel>
              <Action
                title="View & Save"
                onAction={() => push(<MemeDetail meme={meme} onGetAnother={onRefresh} />)}
              />
            </ActionPanel>
          }
        />
      ))}
    </Grid>
  );
}

function MemeDetail({ meme, onGetAnother }: { meme: Meme; onGetAnother: () => void }) {
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
            title="Save Image"
            onAction={() => {
              Clipboard.copy(imageUrl);
            }}
          />
          <Action
            title="Get More Memes"
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