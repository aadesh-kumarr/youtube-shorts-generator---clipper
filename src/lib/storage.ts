import fs from 'fs';

/**
 * Safely deletes files from the disk
 * @param filePaths - Array of absolute file paths to delete
 */
export function cleanupFiles(filePaths: string[]): void {
  console.log(`[storage] Cleaning up temporary files:`, filePaths);
  for (const filePath of filePaths) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[storage] Deleted temp file: ${filePath}`);
      }
    } catch (error: any) {
      console.error(`[storage] Error deleting file ${filePath}: ${error.message || error}`);
    }
  }
}


