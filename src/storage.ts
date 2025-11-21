// Storage Layer - Works on all devices (Web, Android, iOS)
// Priority: IndexedDB (primary) -> LocalStorage (fallback) -> Firebase (optional sync)

import { initializeApp, FirebaseApp } from 'firebase/app';
import { getFirestore, Firestore, doc, setDoc, Timestamp } from 'firebase/firestore';

// Firebase configuration (optional - for desktop/web sync)
const firebaseConfig = {
    // Users can configure this if they want cloud sync
    // If not configured, app works 100% offline
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY || '',
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || '',
    appId: import.meta.env.VITE_FIREBASE_APP_ID || ''
};

let firebaseApp: FirebaseApp | null = null;
let firestore: Firestore | null = null;

// Initialize Firebase only if configured
const initFirebase = () => {
    if (firebaseConfig.apiKey && firebaseConfig.projectId && !firebaseApp) {
        try {
            firebaseApp = initializeApp(firebaseConfig);
            firestore = getFirestore(firebaseApp);
            console.log('Firebase initialized for optional sync');
        } catch (e) {
            console.warn('Firebase init failed, continuing with local-only storage', e);
        }
    }
};

// Storage interface
export interface StorageAdapter {
    saveReport(caseId: string, data: any): Promise<void>;
    getReports(caseId: string): Promise<any[]>;
    saveEvidence(caseId: string, data: any): Promise<void>;
    getEvidence(caseId: string): Promise<any[]>;
    saveCaseMetadata(caseId: string, data: any): Promise<void>;
    getCaseMetadata(caseId: string): Promise<any>;
    getAllCases(): Promise<string[]>;
}

// IndexedDB Implementation (Primary - works on all devices)
class IndexedDBStorage implements StorageAdapter {
    private dbName = 'VerumOmnisDB';
    private version = 3;
    
    private async openDB(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);
            
            request.onupgradeneeded = (event: any) => {
                const db = event.target.result;
                
                if (!db.objectStoreNames.contains('reports')) {
                    const store = db.createObjectStore('reports', { keyPath: 'id', autoIncrement: true });
                    store.createIndex('caseId', 'caseId', { unique: false });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
                
                if (!db.objectStoreNames.contains('evidence_files')) {
                    const fileStore = db.createObjectStore('evidence_files', { keyPath: 'id', autoIncrement: true });
                    fileStore.createIndex('caseId', 'caseId', { unique: false });
                    fileStore.createIndex('fileHash', 'fileHash', { unique: false });
                }
                
                if (!db.objectStoreNames.contains('case_metadata')) {
                    db.createObjectStore('case_metadata', { keyPath: 'caseId' });
                }
            };
            
            request.onsuccess = (event: any) => resolve(event.target.result);
            request.onerror = () => reject(request.error);
        });
    }
    
    async saveReport(caseId: string, data: any): Promise<void> {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('reports', 'readwrite');
            const store = tx.objectStore('reports');
            store.add({ ...data, caseId, timestamp: new Date().toISOString() });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
    
    async getReports(caseId: string): Promise<any[]> {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('reports', 'readonly');
            const store = tx.objectStore('reports');
            const index = store.index('caseId');
            const request = index.getAll(IDBKeyRange.only(caseId));
            request.onsuccess = () => {
                const results = request.result;
                results.sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
                resolve(results);
            };
            request.onerror = () => reject(request.error);
        });
    }
    
    async saveEvidence(caseId: string, data: any): Promise<void> {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('evidence_files', 'readwrite');
            const store = tx.objectStore('evidence_files');
            store.add({ ...data, caseId, timestamp: new Date().toISOString() });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
    
    async getEvidence(caseId: string): Promise<any[]> {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('evidence_files', 'readonly');
            const store = tx.objectStore('evidence_files');
            const index = store.index('caseId');
            const request = index.getAll(IDBKeyRange.only(caseId));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    
    async saveCaseMetadata(caseId: string, data: any): Promise<void> {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('case_metadata', 'readwrite');
            const store = tx.objectStore('case_metadata');
            store.put({ ...data, caseId });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
    
    async getCaseMetadata(caseId: string): Promise<any> {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('case_metadata', 'readonly');
            const store = tx.objectStore('case_metadata');
            const request = store.get(caseId);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }
    
    async getAllCases(): Promise<string[]> {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('reports', 'readonly');
            const store = tx.objectStore('reports');
            const request = store.getAll();
            request.onsuccess = () => {
                const reports = request.result;
                const cases = new Set(reports.map((r: any) => r.caseId).filter(Boolean));
                resolve(Array.from(cases) as string[]);
            };
            request.onerror = () => reject(request.error);
        });
    }
}

// Firebase Sync Layer (Optional - for desktop/multi-device sync)
class FirebaseSync {
    private db: Firestore | null = null;
    
    constructor() {
        initFirebase();
        this.db = firestore;
    }
    
    isAvailable(): boolean {
        return this.db !== null;
    }
    
    async syncReport(caseId: string, data: any): Promise<void> {
        if (!this.db) return;
        try {
            const reportRef = doc(this.db, 'cases', caseId, 'reports', data.id || Date.now().toString());
            await setDoc(reportRef, {
                ...data,
                syncedAt: Timestamp.now()
            });
        } catch (e) {
            console.warn('Firebase sync failed (continuing with local storage)', e);
        }
    }
    
    async syncEvidence(caseId: string, data: any): Promise<void> {
        if (!this.db) return;
        try {
            const evidenceRef = doc(this.db, 'cases', caseId, 'evidence', data.id || Date.now().toString());
            // Don't sync large binary data to Firebase - only metadata
            const { binaryData, ...metadata } = data;
            await setDoc(evidenceRef, {
                ...metadata,
                syncedAt: Timestamp.now(),
                note: 'Binary data stored locally only'
            });
        } catch (e) {
            console.warn('Firebase evidence sync failed', e);
        }
    }
    
    async syncMetadata(caseId: string, data: any): Promise<void> {
        if (!this.db) return;
        try {
            const metaRef = doc(this.db, 'cases', caseId);
            await setDoc(metaRef, {
                ...data,
                syncedAt: Timestamp.now()
            }, { merge: true });
        } catch (e) {
            console.warn('Firebase metadata sync failed', e);
        }
    }
}

// Unified Storage Manager
export class StorageManager {
    private primary: StorageAdapter;
    private sync: FirebaseSync;
    
    constructor() {
        this.primary = new IndexedDBStorage();
        this.sync = new FirebaseSync();
    }
    
    async saveReport(caseId: string, content: string, evidence: string[], metadata?: any): Promise<void> {
        const data = {
            content,
            evidence,
            ...metadata
        };
        
        // Save locally first (always works)
        await this.primary.saveReport(caseId, data);
        
        // Optionally sync to Firebase if available
        if (this.sync.isAvailable()) {
            await this.sync.syncReport(caseId, data);
        }
    }
    
    async getReports(caseId: string): Promise<any[]> {
        return this.primary.getReports(caseId);
    }
    
    async saveEvidence(caseId: string, file: File, fileHash: string, metadata: any): Promise<void> {
        const arrayBuffer = await file.arrayBuffer();
        const data = {
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
            fileHash,
            binaryData: arrayBuffer,
            metadata
        };
        
        // Save locally with binary data
        await this.primary.saveEvidence(caseId, data);
        
        // Sync metadata only to Firebase (not binary data)
        if (this.sync.isAvailable()) {
            await this.sync.syncEvidence(caseId, data);
        }
    }
    
    async getEvidence(caseId: string): Promise<any[]> {
        return this.primary.getEvidence(caseId);
    }
    
    async saveCaseMetadata(caseId: string, metadata: any): Promise<void> {
        await this.primary.saveCaseMetadata(caseId, metadata);
        
        if (this.sync.isAvailable()) {
            await this.sync.syncMetadata(caseId, metadata);
        }
    }
    
    async getCaseMetadata(caseId: string): Promise<any> {
        return this.primary.getCaseMetadata(caseId);
    }
    
    async getAllCases(): Promise<string[]> {
        return this.primary.getAllCases();
    }
    
    // Export all data for desktop backup
    async exportAllData(): Promise<any> {
        const cases = await this.getAllCases();
        const exportData: any = { cases: {}, exportedAt: new Date().toISOString() };
        
        for (const caseId of cases) {
            const reports = await this.getReports(caseId);
            const evidence = await this.getEvidence(caseId);
            const metadata = await this.getCaseMetadata(caseId);
            
            exportData.cases[caseId] = {
                reports,
                evidence: evidence.map(e => ({
                    ...e,
                    binaryData: `<BINARY ${e.fileSize} bytes>` // Don't include in export
                })),
                metadata
            };
        }
        
        return exportData;
    }
}

// Global storage instance
export const storage = new StorageManager();
