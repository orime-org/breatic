import React from 'react';
import { useLoading } from '@/app/hooks/useLoading';
import Loading from './Loading';

/** Shows `<Loading />` while Redux global loading count is greater than zero */
const GlobalLoading: React.FC = () => {
  const isLoading = useLoading();

  if (!isLoading) {
    return null;
  }

  return <Loading />;
};

export default GlobalLoading;

