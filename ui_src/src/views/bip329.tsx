import { useRef, useState, useEffect, useCallback } from "react";
import Button from "../components/button";
import LoginDialog from "../components/login-dialog";
import useLogin from "../hooks/login";
import usePublisher from "../hooks/publisher";
import { Blossom, BlobDescriptor } from "../upload/blossom";
import { Route96, Route96File } from "../upload/admin";
import { ServerUrl } from "../const";

interface Bip329Label {
  type: string;
  ref: string;
  label: string;
  origin?: string;
  spendable?: boolean;
}

// Label with its source file's sha256 so we can update/delete the file
interface StoredLabel {
  label: Bip329Label;
  fileSha256: string;
}

function parseJsonl(text: string): Bip329Label[] | null {
  const labels: Bip329Label[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (!obj.type || !obj.ref || !obj.label) return null;
      labels.push(obj as Bip329Label);
    } catch {
      return null;
    }
  }
  return labels.length > 0 ? labels : null;
}

function toJsonl(labels: Bip329Label[]): string {
  return labels.map((l) => JSON.stringify(l)).join("\n");
}

function getFileUrl(file: Route96File): string | undefined {
  return file.tags.find((t) => t[0] === "url")?.[1];
}

function getFileSha256(file: Route96File): string | undefined {
  return file.tags.find((t) => t[0] === "x")?.[1];
}

export default function Bip329() {
  const login = useLogin();
  const pub = usePublisher();
  const inputRef = useRef<HTMLInputElement>(null);

  const [storedLabels, setStoredLabels] = useState<StoredLabel[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [deletingRef, setDeletingRef] = useState<string>();

  const [fileName, setFileName] = useState<string>();
  const [rawText, setRawText] = useState<string>();
  const [pendingLabels, setPendingLabels] = useState<Bip329Label[]>([]);
  const [parseError, setParseError] = useState<string>();
  const [uploadResult, setUploadResult] = useState<BlobDescriptor>();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string>();

  const loadLabels = useCallback(async () => {
    if (!pub || !login) return;
    setLoading(true);
    setLoadError(undefined);
    try {
      const r96 = new Route96(ServerUrl, pub);
      const result = await r96.listUserFiles(0, 200, "application/octet-stream");
      const allLabels: StoredLabel[] = [];
      await Promise.all(
        result.files.map(async (file) => {
          const url = getFileUrl(file);
          const sha256 = getFileSha256(file);
          if (!url || !sha256) return;
          try {
            const rsp = await fetch(url);
            if (!rsp.ok) return;
            const encrypted = await rsp.text();
            const decrypted = await pub.nip4Decrypt(encrypted, login.publicKey);
            const labels = parseJsonl(decrypted);
            if (labels) {
              allLabels.push(...labels.map((label) => ({ label, fileSha256: sha256 })));
            }
          } catch {
            // Not a BIP-329 file or decryption failed — skip
          }
        }),
      );
      setStoredLabels(allLabels);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [pub, login]);

  useEffect(() => {
    if (pub && login) loadLabels();
  }, [pub, login, loadLabels]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError(undefined);
    setUploadResult(undefined);
    const text = await file.text();
    const parsed = parseJsonl(text);
    if (!parsed) {
      setParseError("Invalid BIP-329 JSONL — each line must have type, ref, and label fields.");
      setPendingLabels([]);
      setRawText(undefined);
      return;
    }
    setFileName(file.name);
    setRawText(text);
    setPendingLabels(parsed);
  }

  async function handleUpload() {
    if (!pub || !login || !rawText || !fileName) return;
    setUploading(true);
    setUploadError(undefined);
    try {
      const encrypted = await pub.nip4Encrypt(rawText, login.publicKey);
      const blob = new Blob([encrypted], { type: "application/octet-stream" });
      const encFile = new File([blob], fileName + ".enc", { type: "application/octet-stream" });
      const uploader = new Blossom(ServerUrl, pub);
      const res = await uploader.upload(encFile);
      setUploadResult(res);
      setPendingLabels([]);
      setRawText(undefined);
      setFileName(undefined);
      await loadLabels();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  function handleDownload() {
    const text = toJsonl(storedLabels.map((s: StoredLabel) => s.label));
    const blob = new Blob([text], { type: "application/jsonl" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "labels.jsonl";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDelete(ref: string) {
    if (!pub || !login) return;
    setDeletingRef(ref);
    try {
      const blossom = new Blossom(ServerUrl, pub);
      // Find which file(s) contain this label
      const affectedSha256s: string[] = [...new Set<string>(
        storedLabels.filter((s: StoredLabel) => s.label.ref === ref).map((s: StoredLabel) => s.fileSha256),
      )];

      for (const sha256 of affectedSha256s) {
        const remaining = storedLabels
          .filter((s: StoredLabel) => s.fileSha256 === sha256 && s.label.ref !== ref)
          .map((s: StoredLabel) => s.label);

        if (remaining.length > 0) {
          // Re-encrypt and re-upload the file without the deleted label
          const newText = toJsonl(remaining);
          const encrypted = await pub.nip4Encrypt(newText, login.publicKey);
          const blob = new Blob([encrypted], { type: "application/octet-stream" });
          const encFile = new File([blob], "labels.jsonl.enc", { type: "application/octet-stream" });
          await blossom.upload(encFile);
        }
        // Delete the original file
        await blossom.delete(sha256);
      }

      await loadLabels();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingRef(undefined);
    }
  }

  if (!login) return <LoginDialog />;

  return (
    <div className="max-w-3xl space-y-4">
      {/* Upload panel */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-sm p-4 space-y-3">
        <h2 className="text-sm font-semibold text-white">BIP-329 Label Upload</h2>
        <p className="text-xs text-neutral-500">
          Select a JSONL file with BIP-329 wallet labels. It will be encrypted with
          your Nostr key before upload — only you can decrypt it.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".jsonl,.txt"
          className="hidden"
          onChange={handleFileChange}
        />
        <Button onClick={() => inputRef.current?.click()} size="sm">
          {fileName ? `Selected: ${fileName}` : "Select JSONL File"}
        </Button>
        {parseError && (
          <div className="bg-red-950 border border-red-900 text-red-200 px-3 py-2 rounded-sm text-xs">
            {parseError}
          </div>
        )}
      </div>

      {/* Preview + upload button */}
      {pendingLabels.length > 0 && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-sm p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-neutral-400">
              {pendingLabels.length} label{pendingLabels.length !== 1 ? "s" : ""} to upload
            </span>
            <Button onClick={handleUpload} disabled={uploading} size="sm">
              {uploading ? "Encrypting & uploading…" : "Encrypt & Upload"}
            </Button>
          </div>
          {uploadError && (
            <div className="bg-red-950 border border-red-900 text-red-200 px-3 py-2 rounded-sm text-xs">
              {uploadError}
            </div>
          )}
          <LabelTable labels={pendingLabels} />
        </div>
      )}

      {uploadResult && (
        <div className="bg-neutral-900 border border-green-900 rounded-sm p-3 space-y-1">
          <span className="text-xs text-green-400">Uploaded successfully</span>
          <div className="flex items-center gap-2">
            <code className="text-xs text-green-300 bg-neutral-950 px-2 py-1 rounded-sm flex-1 truncate">
              {uploadResult.url}
            </code>
            <button
              onClick={() => uploadResult.url && navigator.clipboard.writeText(uploadResult.url)}
              className="text-xs bg-neutral-800 hover:bg-neutral-700 text-white px-2 py-1 rounded-sm"
            >
              Copy
            </button>
          </div>
        </div>
      )}

      {/* Stored labels */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-sm p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">
            Stored Labels
            {storedLabels.length > 0 && (
              <span className="ml-2 text-xs font-normal text-neutral-500">
                ({storedLabels.length})
              </span>
            )}
          </h2>
          <div className="flex gap-3">
            {storedLabels.length > 0 && (
              <button
                onClick={handleDownload}
                className="text-xs text-neutral-500 hover:text-white transition-colors"
              >
                Download .jsonl
              </button>
            )}
            <button
              onClick={loadLabels}
              disabled={loading}
              className="text-xs text-neutral-500 hover:text-white transition-colors disabled:opacity-50"
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>

        {loadError && (
          <div className="bg-red-950 border border-red-900 text-red-200 px-3 py-2 rounded-sm text-xs">
            {loadError}
          </div>
        )}

        {loading && storedLabels.length === 0 && (
          <p className="text-xs text-neutral-500">Fetching and decrypting files…</p>
        )}

        {!loading && storedLabels.length === 0 && !loadError && (
          <p className="text-xs text-neutral-500">No BIP-329 label files found.</p>
        )}

        {storedLabels.length > 0 && (
          <LabelTable
            labels={storedLabels.map((s: StoredLabel) => s.label)}
            deletingRef={deletingRef}
            onDelete={handleDelete}
          />
        )}
      </div>
    </div>
  );
}

function LabelTable({
  labels,
  onDelete,
  deletingRef,
}: {
  labels: Bip329Label[];
  onDelete?: (ref: string) => void;
  deletingRef?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="text-left text-neutral-500 border-b border-neutral-800">
            <th className="pb-1 pr-4 font-normal">Type</th>
            <th className="pb-1 pr-4 font-normal">Label</th>
            <th className="pb-1 pr-4 font-normal">Ref</th>
            <th className="pb-1 font-normal">Origin</th>
            {onDelete && <th className="pb-1 font-normal"></th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800">
          {labels.map((l, i) => (
            <tr key={i} className="text-neutral-300">
              <td className="py-1 pr-4">
                <span className="bg-neutral-800 px-1.5 py-0.5 rounded-sm text-neutral-400">
                  {l.type}
                </span>
              </td>
              <td className="py-1 pr-4">{l.label}</td>
              <td className="py-1 pr-4 font-mono text-neutral-500 max-w-xs truncate">{l.ref}</td>
              <td className="py-1 text-neutral-500">{l.origin ?? "—"}</td>
              {onDelete && (
                <td className="py-1 pl-2">
                  <button
                    onClick={() => onDelete(l.ref)}
                    disabled={deletingRef === l.ref}
                    className="text-neutral-600 hover:text-red-400 transition-colors disabled:opacity-40"
                  >
                    {deletingRef === l.ref ? "…" : "✕"}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
