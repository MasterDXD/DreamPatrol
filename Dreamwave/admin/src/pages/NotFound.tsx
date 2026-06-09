import { useNavigate } from 'react-router-dom';

export default function NotFound() {
  const navigate = useNavigate();

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 400,
      textAlign: 'center',
    }}>
      <h1 style={{
        fontSize: 72,
        fontWeight: 700,
        color: '#4cd7f6',
        textShadow: '0 0 30px rgba(76,215,246,0.4)',
        marginBottom: 8,
      }}>
        404
      </h1>
      <p style={{ color: '#c6c6cd', fontSize: 16, marginBottom: 24 }}>
        抱歉，您访问的页面不存在
      </p>
      <button
        className="btn-dream"
        onClick={() => navigate('/')}
        style={{
          padding: '10px 32px',
          borderRadius: 9999,
          cursor: 'pointer',
          fontSize: 14,
          fontWeight: 500,
        }}
      >
        返回首页
      </button>
    </div>
  );
}
