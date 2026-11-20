"use client";
// A picture field on the edit screen: the chosen picture, a button to choose one from the library, and one to take it away.
// The value is the id of the file in the library.
import { Button } from "oks-ui";
import { useEffect, useState } from "react";
import { loadFile } from "./media-client";
import { MediaPicker } from "./media-picker";

export function PictureField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<{ url: string; alt: string } | null>(null);
  useEffect(() => {
    let current = true;
    if (!value) {
      setShown(null);
      return;
    }
    void loadFile(value)
      .then(({ item }) => {
        if (current) setShown({ url: item.url, alt: item.alt });
      })
      .catch(() => {
        if (current) setShown(null);
      });
    return () => {
      current = false;
    };
  }, [value]);
  return (
    <span style={{ display: "block" }}>
      {value && shown ? (
        <img
          src={shown.url}
          alt={shown.alt}
          style={{
            display: "block",
            maxInlineSize: "12rem",
            blockSize: "auto",
            margin: "0.25rem 0",
          }}
        />
      ) : null}
      <Button onPress={() => setOpen(true)}>{value ? "Change picture" : "Choose picture"}</Button>{" "}
      {value ? <Button onPress={() => onChange("")}>Remove picture</Button> : null}
      <MediaPicker
        isOpen={open}
        onClose={() => setOpen(false)}
        onPick={(item) => {
          setOpen(false);
          onChange(item.id);
        }}
        title={`Choose a picture for ${label}`}
        pickLabel="Use this picture"
      />
    </span>
  );
}
