import { useState, useRef, useCallback, useEffect } from 'react';
import styles from './VoiceInput.module.css';

interface VoiceInputProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

export default function VoiceInput({ onTranscript, disabled }: VoiceInputProps) {
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const lastTranscriptRef = useRef<string>('');

  const isSupported = typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  const startListening = useCallback(() => {
    if (!isSupported || isListening) return;
    lastTranscriptRef.current = '';
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SR();
    recognition.lang = 'zh-CN';
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onresult = (event: any) => {
      const result = Array.from(event.results)
        .map((r: any) => r[0].transcript)
        .join('');
      if (result && result !== lastTranscriptRef.current) {
        lastTranscriptRef.current = result;
        onTranscript(result);
      }
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [isSupported, isListening, onTranscript]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, []);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
        recognitionRef.current = null;
      }
    };
  }, []);

  if (!isSupported) {
    return <span className={styles.unsupported}>🎤 您的浏览器不支持语音输入</span>;
  }

  return (
    <button
      onClick={isListening ? stopListening : startListening}
      disabled={disabled}
      className={`${styles.voiceBtn} ${isListening ? styles.voiceBtnListening : ''}`}
    >
      <span className={`${styles.icon} ${isListening ? styles.iconListening : ''}`}>🎤</span>
      <span>{isListening ? '点击停止' : '语音记录'}</span>
    </button>
  );
}
