import React, { forwardRef } from 'react';
import './Button.css';

const Button = forwardRef(function Button({
  children,
  variant = 'default',
  size = 'default',
  className = '',
  disabled,
  ...props
}, ref) {
  return (
    <button
      ref={ref}
      className={`btn btn-${variant} btn-size-${size} ${className}`}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
});

export default Button;
