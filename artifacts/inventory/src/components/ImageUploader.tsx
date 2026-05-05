import { useRef } from "react";
import { useUpload } from "@workspace/object-storage-web";
import { Button } from "@/components/ui/button";
import { ImageIcon, Loader2, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useImageSrc } from "@/hooks/use-image-src";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface Props {
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  /** Used for accessible labelling and `data-testid` suffixes. */
  testId?: string;
}

/**
 * Thumbnail + upload button for an item's product image.
 *
 * Uses the presigned-URL flow from the object-storage client lib: requests a
 * one-shot URL from the API, PUTs the file directly to GCS, then stores the
 * normalized object path in the form. We do NOT keep the file in component
 * state — the parent form holds the value via React Hook Form.
 */
export function ImageUploader({ value, onChange, testId }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { uploadFile, isUploading } = useUpload({
    onError: (err: Error) => {
      toast({
        variant: "destructive",
        title: "Image upload failed",
        description: err.message,
      });
    },
  });

  const { src } = useImageSrc(value);
  const tid = testId ?? "image";

  const onPick = () => inputRef.current?.click();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({
        variant: "destructive",
        title: "Unsupported file",
        description: "Please choose an image (JPG, PNG, WebP).",
      });
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast({
        variant: "destructive",
        title: "Image too large",
        description: "Maximum size is 5 MB.",
      });
      return;
    }
    const result = await uploadFile(file);
    if (result?.objectPath) {
      onChange(result.objectPath);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <div
        className="h-20 w-20 shrink-0 rounded-md border bg-muted/40 overflow-hidden flex items-center justify-center"
        data-testid={`thumb-${tid}`}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt="Product"
            className="h-full w-full object-cover"
          />
        ) : (
          <ImageIcon className="h-6 w-6 text-muted-foreground" aria-hidden />
        )}
      </div>
      <div className="flex flex-col gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onFile}
          data-testid={`input-${tid}-file`}
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onPick}
            disabled={isUploading}
            data-testid={`btn-${tid}-upload`}
          >
            {isUploading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Uploading...
              </>
            ) : src ? (
              "Replace image"
            ) : (
              "Upload image"
            )}
          </Button>
          {src && !isUploading && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(null)}
              data-testid={`btn-${tid}-remove`}
            >
              <X className="mr-1 h-4 w-4" />
              Remove
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          JPG, PNG, or WebP. Up to 5 MB.
        </p>
      </div>
    </div>
  );
}
