import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI } from "@google/genai";
import * as pdfjsLib from 'pdfjs-dist';
import { UploadIcon, ClipboardIcon, CheckIcon, RefreshIcon, ClockIcon, XCircleIcon, TrashIcon, DownloadIcon } from './components/icons';

// Setup PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// FIX: The API key must be obtained exclusively from `process.env.API_KEY` as per the coding guidelines.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

interface FileStatus {
  id: string;
  file: File;
  status: 'pending' | 'processing' | 'success' | 'error';
  message: string;
  extractedText?: string;
  pageProgress?: { current: number; total: number };
}

type BatchState = 'idle' | 'processing' | 'done';


const App: React.FC = () => {
  const [fileQueue, setFileQueue] = useState<FileStatus[]>([]);
  const [batchState, setBatchState] = useState<BatchState>('idle');
  const [copiedFileId, setCopiedFileId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeAccordion, setActiveAccordion] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  useEffect(() => {
    try {
      const storedHistory = localStorage.getItem('pdfConverterHistory');
      if (storedHistory) {
        setHistory(JSON.parse(storedHistory));
      }
    } catch (error) {
      console.error("Failed to load history from localStorage:", error);
      setHistory([]);
    }
  }, []);

  const updateHistory = (newFileNames: string[]) => {
    setHistory(prevHistory => {
      const updatedHistory = Array.from(new Set([...prevHistory, ...newFileNames]));
      try {
        localStorage.setItem('pdfConverterHistory', JSON.stringify(updatedHistory));
      } catch (error) {
        console.error("Failed to save history to localStorage:", error);
      }
      return updatedHistory;
    });
  };

  const clearHistory = () => {
    try {
      localStorage.removeItem('pdfConverterHistory');
      setHistory([]);
    } catch (error) {
      console.error("Failed to clear history from localStorage:", error);
    }
  };


  const extractTextFromImage = useCallback(async (base64Image: string): Promise<string> => {
    try {
      const imagePart = {
        inlineData: {
          mimeType: 'image/jpeg',
          data: base64Image.split(',')[1],
        },
      };

      const textPart = {
        text: "זהו עמוד מתוך מסמך PDF. חלץ את טקסט התוכן המרכזי בעברית שאתה רואה בתמונה. התעלם באופן מוחלט מטקסט שנראה כמו כותרת עליונה (header) או כותרת תחתונה (footer), כגון מספרי עמודים, שמות מסמכים שחוזרים על עצמם בראש העמוד, או פרטי קשר בתחתית העמוד. התמקד בפסקאות ובגוף הטקסט העיקרי. הצג רק את הטקסט שחולץ, ללא כותרות או הסברים נוספים.",
      };

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: { parts: [imagePart, textPart] },
      });

      return response.text;
    } catch (error) {
      console.error("Error calling Gemini API:", error);
      throw new Error('שגיאה בתקשורת עם ה-API של Gemini.');
    }
  }, []);

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    const newFiles: FileStatus[] = Array.from(files)
        .filter(file => file.type === 'application/pdf')
        .map(file => ({
            id: `${file.name}-${file.lastModified}-${file.size}`,
            file,
            status: 'pending',
            message: 'ממתין לעיבוד'
        }));

    setFileQueue(prevQueue => {
        const existingIds = new Set(prevQueue.map(f => f.id));
        const uniqueNewFiles = newFiles.filter(f => !existingIds.has(f.id));
        return [...prevQueue, ...uniqueNewFiles];
    });
    setBatchState('idle'); 
    setActiveAccordion(null);
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    handleFiles(event.target.files);
    event.target.value = ''; // Reset input to allow re-uploading the same file
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    handleFiles(event.dataTransfer.files);
  };
  
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };
  
  const removeFile = (idToRemove: string) => {
    setFileQueue(prev => prev.filter(item => item.id !== idToRemove));
  };
  
  const processBatch = async () => {
    if (!fileQueue.some(f => f.status === 'pending')) return;
    setBatchState('processing');
    setActiveAccordion(null);

    let processedQueue = [...fileQueue];

    for (const fileStatus of fileQueue) {
        if (fileStatus.status !== 'pending') continue;

        processedQueue = processedQueue.map(item => item.id === fileStatus.id ? { ...item, status: 'processing', message: 'מתחיל עיבוד...' } : item);
        setFileQueue(processedQueue);

        try {
            const arrayBuffer = await fileStatus.file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            const numPages = pdf.numPages;
            let fullText = '';

            for (let i = 1; i <= numPages; i++) {
                processedQueue = processedQueue.map(item => item.id === fileStatus.id ? { ...item, pageProgress: { current: i, total: numPages }, message: `מעבד עמוד ${i} מתוך ${numPages}` } : item);
                setFileQueue(processedQueue);

                const page = await pdf.getPage(i);
                const viewport = page.getViewport({ scale: 2.0 });
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                canvas.height = viewport.height;
                canvas.width = viewport.width;

                if (!context) throw new Error('לא ניתן היה ליצור קונטקסט של קנבס.');

                await page.render({ canvasContext: context, viewport: viewport }).promise;
                const base64Image = canvas.toDataURL('image/jpeg', 0.9);
                const textFromPage = await extractTextFromImage(base64Image);
                fullText += textFromPage.trim() + '\n\n---\n\n';
            }
            
            processedQueue = processedQueue.map(item => item.id === fileStatus.id ? { ...item, status: 'success', extractedText: fullText.trim(), message: 'העיבוד הושלם בהצלחה' } : item);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'אירעה שגיאה לא צפויה.';
            processedQueue = processedQueue.map(item => item.id === fileStatus.id ? { ...item, status: 'error', message: errorMessage } : item);
        } finally {
            setFileQueue(processedQueue);
        }
    }
    
    const successfulFiles = processedQueue.filter(f => f.status === 'success');
    if (successfulFiles.length > 0) {
      updateHistory(successfulFiles.map(f => f.file.name));
    }
    
    setBatchState('done');
  };

  const resetState = () => {
    setFileQueue([]);
    setBatchState('idle');
    setCopiedFileId(null);
    setActiveAccordion(null);
    if (fileInputRef.current) {
        fileInputRef.current.value = '';
    }
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedFileId(id);
    setTimeout(() => setCopiedFileId(null), 2000);
  };
  
    const handleExportAll = () => {
    const successfulFiles = fileQueue.filter(f => f.status === 'success');
    if (successfulFiles.length === 0) return;

    const content = successfulFiles.map(item => 
      `========== START: ${item.file.name} ==========\n\n${item.extractedText}\n\n========== END: ${item.file.name} ==========`
    ).join('\n\n\n');

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'pdf_extraction_results.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const StatusIcon = ({ status }: { status: FileStatus['status'] }) => {
    switch (status) {
      case 'pending': return <ClockIcon className="w-5 h-5 text-yellow-400" />;
      case 'processing': return <svg className="animate-spin h-5 w-5 text-cyan-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>;
      case 'success': return <CheckIcon className="w-5 h-5 text-green-400" />;
      case 'error': return <XCircleIcon className="w-5 h-5 text-red-400" />;
      default: return null;
    }
  };

  const hasPendingFiles = fileQueue.some(f => f.status === 'pending');
  const successfulFiles = fileQueue.filter(f => f.status === 'success');

  return (
    <div className="bg-slate-900 text-white min-h-screen flex flex-col items-center p-4 sm:p-6 lg:p-8 font-sans">
      <div className="w-full max-w-4xl mx-auto">
        <header className="text-center mb-8">
          <h1 className="text-4xl sm:text-5xl font-bold text-cyan-400">ממיר PDF עברי לתמליל</h1>
          <p className="text-slate-400 mt-2 text-lg">
            העלה קבצי PDF, ואנו נחלץ את הטקסט המרכזי מכל עמוד עבורך.
          </p>
        </header>

        <main className="bg-slate-800 p-6 sm:p-8 rounded-2xl shadow-2xl shadow-cyan-500/10 w-full">
          {fileQueue.length === 0 && (
            <div 
              className="w-full border-2 border-dashed border-slate-600 rounded-xl p-8 sm:p-12 text-center cursor-pointer hover:border-cyan-400 hover:bg-slate-700 transition-all duration-300"
              onClick={() => fileInputRef.current?.click()}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
            >
              <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="application/pdf" className="hidden" multiple />
              <UploadIcon className="w-16 h-16 mx-auto text-slate-500 mb-4"/>
              <p className="text-slate-300">גרור ושחרר קבצי PDF כאן, או <span className="text-cyan-400 font-semibold">לחץ לבחירה</span></p>
              <p className="text-xs text-slate-500 mt-2">ניתן לבחור מספר קבצים</p>
            </div>
          )}

          {fileQueue.length > 0 && (
            <div>
              <h2 className="text-2xl font-bold text-cyan-400 mb-4">תור עיבוד</h2>
              <div className="space-y-3 max-h-80 overflow-y-auto pr-2">
                {fileQueue.map(item => (
                  <div key={item.id} className="bg-slate-700/50 p-3 rounded-lg flex items-center justify-between">
                    <div className="flex items-center space-x-3 rtl:space-x-reverse min-w-0">
                      <StatusIcon status={item.status} />
                      <div className="flex-1 min-w-0">
                        <p className="font-mono text-cyan-300 truncate text-sm" title={item.file.name}>{item.file.name}</p>
                        <p className="text-xs text-slate-400">{item.message}</p>
                      </div>
                    </div>
                    {batchState !== 'processing' && (
                       <button onClick={() => removeFile(item.id)} className="text-slate-500 hover:text-red-400 transition-colors">
                           <XCircleIcon className="w-5 h-5"/>
                       </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="mt-6 flex flex-wrap gap-4 justify-center">
                <button
                  onClick={processBatch}
                  disabled={!hasPendingFiles || batchState === 'processing'}
                  className="px-8 py-3 bg-cyan-500 text-slate-900 font-bold rounded-lg hover:bg-cyan-400 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-800 focus:ring-cyan-500 transition-all duration-300 disabled:bg-slate-600 disabled:cursor-not-allowed flex items-center justify-center"
                >
                  {batchState === 'processing' ? (
                    <>
                      <svg className="animate-spin -ml-1 mr-3 h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                      <span>מעבד...</span>
                    </>
                  ) : `המר ${fileQueue.filter(f=>f.status==='pending').length} קבצים`}
                </button>
                {batchState !== 'processing' && (
                  <button onClick={resetState} className="flex items-center px-6 py-3 bg-slate-700 text-cyan-300 rounded-lg hover:bg-slate-600 transition-colors font-semibold">
                      <TrashIcon className="w-5 h-5 mr-2 rtl:ml-2"/>
                      נקה הכל
                  </button>
                )}
              </div>
            </div>
          )}

          {batchState === 'done' && successfulFiles.length > 0 && (
             <div className="mt-8">
                <div className="flex flex-wrap gap-4 justify-between items-center mb-4">
                     <h2 className="text-2xl font-bold text-cyan-400">תוצאות החילוץ:</h2>
                     <div className="flex gap-2">
                         <button onClick={handleExportAll} className="flex items-center px-4 py-2 bg-slate-700 text-cyan-300 rounded-lg hover:bg-slate-600 transition-colors font-semibold">
                            <DownloadIcon className="w-5 h-5 mr-2 rtl:ml-2"/>
                            ייצא הכל
                        </button>
                         <button onClick={resetState} className="flex items-center px-4 py-2 bg-cyan-500 text-slate-900 rounded-lg hover:bg-cyan-400 transition-colors font-semibold">
                            <RefreshIcon className="w-5 h-5 mr-2 rtl:ml-2"/>
                            התחל מחדש
                        </button>
                     </div>
                </div>
                <div className="space-y-4">
                  {successfulFiles.map(item => (
                    <div key={item.id} className="bg-slate-800 rounded-lg border border-slate-700">
                      <button onClick={() => setActiveAccordion(activeAccordion === item.id ? null : item.id)} className="w-full flex justify-between items-center p-4 text-right">
                         <span className="font-semibold text-cyan-300">{item.file.name}</span>
                         <svg className={`w-6 h-6 transform transition-transform ${activeAccordion === item.id ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
                      </button>
                      {activeAccordion === item.id && (
                        <div className="p-4 border-t border-slate-700">
                           <button onClick={() => handleCopy(item.id, item.extractedText || '')} className="flex items-center px-4 py-2 mb-4 bg-slate-700 text-cyan-300 rounded-lg hover:bg-slate-600 transition-colors">
                              {copiedFileId === item.id ? <CheckIcon className="w-5 h-5 mr-2 rtl:ml-2"/> : <ClipboardIcon className="w-5 h-5 mr-2 rtl:ml-2"/>}
                              {copiedFileId === item.id ? 'הועתק!' : 'העתק הכל'}
                          </button>
                          <textarea
                              readOnly
                              value={item.extractedText}
                              className="w-full h-80 p-4 bg-slate-900 text-slate-300 rounded-lg border border-slate-700 focus:ring-2 focus:ring-cyan-500 focus:outline-none font-mono"
                              placeholder="הטקסט שחולץ יופיע כאן..."
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
            </div>
          )}

        </main>

        {history.length > 0 && batchState !== 'processing' && (
          <section className="w-full mt-8 bg-slate-800 p-6 sm:p-8 rounded-2xl shadow-lg">
             <div className="flex justify-between items-center mb-4">
                <h3 className="text-xl font-bold text-cyan-400">היסטוריית קבצים</h3>
                <button onClick={clearHistory} className="flex items-center text-sm text-slate-400 hover:text-red-400 transition-colors">
                    <TrashIcon className="w-4 h-4 mr-1 rtl:ml-1"/>
                    נקה היסטוריה
                </button>
             </div>
             <ul className="space-y-2 max-h-48 overflow-y-auto pr-2 text-slate-400 font-mono text-sm">
                {history.map((fileName, index) => (
                    <li key={index} className="truncate" title={fileName}>{fileName}</li>
                ))}
             </ul>
          </section>
        )}
      </div>
    </div>
  );
};

export default App;
