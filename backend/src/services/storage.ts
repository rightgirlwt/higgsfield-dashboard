import crypto from 'node:crypto';
import { badRequest } from '../lib/errors';
import { getSecret } from './secrets';
import { getStorage } from './settings';

const ALLOWED = /^(image\/(png|jpe?g|webp|gif|avif)|video\/(mp4|webm|quicktime))$/i;
const MAX_BYTES = 500 * 1024 * 1024;

export interface UploadTarget {
  uploadUrl: string;
  publicUrl: string;
  key: string;
  expiresInSec: number;
  headers: Record<string, string>;
}

/**
 * Presigned PUT for direct browser → S3-compatible storage upload (S3, R2, MinIO, B2…).
 * NOTE: not exercised against a live bucket in this repo's automated tests.
 */
export async function createUploadUrl(orgId: string, filename: string, contentType: string): Promise<UploadTarget> {
  if (!ALLOWED.test(contentType)) throw badRequest('Only common image and video types can be uploaded');
  const cfg = await getStorage(orgId);
  const accessKeyId = await getSecret(orgId, 's3_access_key_id');
  const secretAccessKey = await getSecret(orgId, 's3_secret_access_key');
  if (!cfg.bucket || !accessKeyId || !secretAccessKey) {
    throw badRequest('Storage is not configured. Add a bucket and access keys in Settings → Storage.');
  }
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const client = new S3Client({
    region: cfg.region || 'us-east-1',
    endpoint: cfg.endpoint || undefined,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
  });
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'upload';
  const key = `${orgId}/${crypto.randomUUID()}-${safe}`;
  const expiresInSec = 300;
  const uploadUrl = await getSignedUrl(client, new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: contentType }), { expiresIn: expiresInSec });
  const base = cfg.publicBaseUrl ? cfg.publicBaseUrl.replace(/\/$/, '') : `${(cfg.endpoint || `https://s3.${cfg.region}.amazonaws.com`).replace(/\/$/, '')}/${cfg.bucket}`;
  return { uploadUrl, publicUrl: `${base}/${key}`, key, expiresInSec, headers: { 'Content-Type': contentType } };
}

export const UPLOAD_MAX_BYTES = MAX_BYTES;
